//! Shared event timing and environment ownership for scope evaluation.
//!
//! An event's anchor determines its owning function; its activation boundary
//! determines when its effects become visible. Definitions use their recorded
//! activation boundary (including assignment RHS completion), sources and
//! removals activate strictly after their call site, and pre-entry
//! batches before ordinary file execution. Deferred queries observe completed
//! global state while retaining position-aware function-local state.
//!
//! Point resolvers use `QueryContext` to decide whether an event participates.
//! Streaming resolution uses the same `EventContext` for timeline ordering,
//! frame routing, and completed-global filtering. This module owns policy, not
//! traversal, mutations, source locality, or caches. Activated Shiny intervals
//! are inputs: only the ordered attachment projection may discover them.

use std::borrow::Cow;
use std::collections::HashSet;

use super::{FunctionScopeInterval, Position, ScopeEvent, SourceBatchBoundary};

/// The environment observed by a lookup after applying the hoisting setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ScopePhase {
    Immediate,
    Deferred,
}

impl ScopePhase {
    /// Adapt a hoisting-aware function context to its evaluation phase.
    pub(super) fn from_deferred(deferred: bool) -> Self {
        if deferred {
            Self::Deferred
        } else {
            Self::Immediate
        }
    }

    /// Whether globals are read from their completed environment.
    pub(super) fn is_deferred(self) -> bool {
        self == Self::Deferred
    }
}

/// Activation rules are distinct from the lexical anchor used for ownership.
#[derive(Clone, Copy)]
enum EventTiming {
    At(Position),
    After(Position),
    OrderedBatch(Position),
    FunctionBody(FunctionScopeInterval),
    PreEntry(SourceBatchBoundary),
}

/// One event's timing and effective owner, shared by every evaluator.
#[derive(Clone, Copy)]
pub(super) struct EventContext {
    anchor: Position,
    timing: EventTiming,
    pub(super) owner: Option<FunctionScopeInterval>,
}

impl EventContext {
    /// Classify every event variant in one place, before conditional-scope overlay.
    pub(super) fn new(event: &ScopeEvent) -> Self {
        let (anchor, timing, owner) = match event {
            ScopeEvent::Def {
                line,
                column,
                visible_from_line,
                visible_from_column,
                function_scope,
                ..
            } => (
                Position::new(*line, *column),
                EventTiming::At(Position::new(*visible_from_line, *visible_from_column)),
                *function_scope,
            ),
            ScopeEvent::Source {
                line,
                column,
                function_scope,
                ..
            }
            | ScopeEvent::Removal {
                line,
                column,
                function_scope,
                ..
            } => {
                let anchor = Position::new(*line, *column);
                (anchor, EventTiming::After(anchor), *function_scope)
            }
            ScopeEvent::PackageLoad {
                line,
                column,
                function_scope,
                ..
            }
            | ScopeEvent::DataLoad {
                line,
                column,
                function_scope,
                ..
            }
            | ScopeEvent::Declaration {
                line,
                column,
                function_scope,
                ..
            }
            | ScopeEvent::SelectiveImport {
                line,
                column,
                function_scope,
                ..
            } => {
                let anchor = Position::new(*line, *column);
                (anchor, EventTiming::At(anchor), *function_scope)
            }
            ScopeEvent::FunctionScope {
                start_line,
                start_column,
                end_line,
                end_column,
                ..
            } => {
                let interval = FunctionScopeInterval::new(
                    Position::new(*start_line, *start_column),
                    Position::new(*end_line, *end_column),
                );
                (interval.start, EventTiming::FunctionBody(interval), None)
            }
            ScopeEvent::SourceBatch {
                line, column, kind, ..
            } => {
                let anchor = Position::new(*line, *column);
                let timing = if kind.is_pre_entry() {
                    EventTiming::PreEntry(SourceBatchBoundary {
                        line: *line,
                        column: *column,
                        kind: *kind,
                    })
                } else {
                    EventTiming::OrderedBatch(anchor)
                };
                (anchor, timing, None)
            }
        };
        Self {
            anchor,
            timing,
            owner,
        }
    }

    /// Overlay activated deferred bodies on events with ordinary lexical ownership.
    pub(super) fn with_conditional_scopes(
        mut self,
        activated: &HashSet<FunctionScopeInterval>,
    ) -> Self {
        // Batches are file-environment stages; FunctionScope creates a frame.
        // Neither acquires the ownership of a conditional body at its anchor.
        if !matches!(
            self.timing,
            EventTiming::FunctionBody(_) | EventTiming::PreEntry(_) | EventTiming::OrderedBatch(_)
        ) {
            self.owner = innermost_effective_scope(
                activated,
                self.anchor.line,
                self.anchor.column,
                self.owner,
            );
        }
        self
    }

    /// Whether this event belongs in the completed global frame.
    pub(super) fn is_global(self) -> bool {
        self.owner.is_none() && !matches!(self.timing, EventTiming::FunctionBody(_))
    }

    /// Stream activation key. Strict boundaries retain the historical saturated
    /// column representation; point queries compare the original boundary directly.
    fn effect_position(self) -> (u32, u32) {
        match self.timing {
            EventTiming::At(position) => (position.line, position.column),
            EventTiming::After(position) | EventTiming::OrderedBatch(position) => {
                (position.line, position.column.saturating_add(1))
            }
            EventTiming::FunctionBody(interval) => (interval.start.line, interval.start.column),
            EventTiming::PreEntry(_) => (0, 0),
        }
    }
}

/// Why an event participates; hoisted removals retain distinct bookkeeping.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EventVisibility {
    Hidden,
    Positional,
    Hoisted,
}

/// A position query's effective environment, prepared once for its timeline walk.
pub(super) struct QueryContext<'a> {
    position: Position,
    pub(super) phase: ScopePhase,
    active_scopes: Cow<'a, HashSet<FunctionScopeInterval>>,
    conditional_scopes: &'a HashSet<FunctionScopeInterval>,
    pre_entry_cutoff: Option<SourceBatchBoundary>,
}

impl<'a> QueryContext<'a> {
    /// Combine lexical and activated conditional scopes without cloning the
    /// ordinary set when no conditional scopes are active. Full EOF is outside
    /// every function; a MAX column on an ordinary line is still a body query.
    pub(super) fn new(
        position: Position,
        hoist_globals: bool,
        ordinary_scopes: &'a HashSet<FunctionScopeInterval>,
        conditional_scopes: &'a HashSet<FunctionScopeInterval>,
        pre_entry_cutoff: Option<SourceBatchBoundary>,
    ) -> Self {
        let active_scopes = if conditional_scopes.is_empty() {
            Cow::Borrowed(ordinary_scopes)
        } else {
            Cow::Owned(
                ordinary_scopes
                    .iter()
                    .copied()
                    .chain(
                        conditional_scopes
                            .iter()
                            .filter(|scope| scope.contains(position))
                            .copied(),
                    )
                    .collect(),
            )
        };
        let phase = ScopePhase::from_deferred(hoist_globals && !active_scopes.is_empty());
        Self {
            position,
            phase,
            active_scopes,
            conditional_scopes,
            pre_entry_cutoff,
        }
    }

    /// Resolve ownership and timing together so event consumers cannot select
    /// a different environment from the one used by the visibility decision.
    pub(super) fn evaluate(&self, event: &ScopeEvent) -> (EventContext, EventVisibility) {
        let context = EventContext::new(event).with_conditional_scopes(self.conditional_scopes);
        let positional = match context.timing {
            EventTiming::At(position) => position <= self.position,
            EventTiming::After(position) | EventTiming::OrderedBatch(position) => {
                position < self.position
            }
            EventTiming::FunctionBody(interval) => {
                return (
                    context,
                    if !self.position.is_full_eof() && interval.contains(self.position) {
                        EventVisibility::Positional
                    } else {
                        EventVisibility::Hidden
                    },
                );
            }
            EventTiming::PreEntry(boundary) => {
                return (
                    context,
                    if self.pre_entry_cutoff.is_none_or(|cutoff| boundary < cutoff) {
                        EventVisibility::Positional
                    } else {
                        EventVisibility::Hidden
                    },
                );
            }
        };
        let visibility = if context
            .owner
            .is_some_and(|scope| !self.active_scopes.contains(&scope))
        {
            EventVisibility::Hidden
        } else if positional {
            EventVisibility::Positional
        } else if context.is_global() && self.phase.is_deferred() {
            EventVisibility::Hoisted
        } else {
            EventVisibility::Hidden
        };
        (context, visibility)
    }
}

/// Choose the innermost activated or ordinary owner at an event's anchor.
pub(super) fn innermost_effective_scope(
    activated: &HashSet<FunctionScopeInterval>,
    line: u32,
    column: u32,
    ordinary: Option<FunctionScopeInterval>,
) -> Option<FunctionScopeInterval> {
    if activated.is_empty() {
        return ordinary;
    }
    activated
        .iter()
        .filter(|scope| scope.contains(Position::new(line, column)))
        .copied()
        .chain(ordinary)
        .max_by_key(|scope| scope.start)
}

/// Sort pre-entry stages before the ordinary event timeline.
pub(super) fn event_sort_key(event: &ScopeEvent) -> (u8, u32, u32) {
    let context = EventContext::new(event);
    let (line, column) = context.effect_position();
    (
        u8::from(!matches!(context.timing, EventTiming::PreEntry(_))),
        line,
        column,
    )
}

/// Position where the stream can apply an event, shared with artifact ordering.
pub(in crate::cross_file) fn event_effect_position(event: &ScopeEvent) -> (u32, u32) {
    EventContext::new(event).effect_position()
}
