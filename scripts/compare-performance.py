#!/usr/bin/env python3
"""Build and compare two revisions on one machine, without cached measurements.

Builds finish before three serial paired measurements start. The middle pair
reverses execution order to expose drift. Each revision gets a new target
directory: Cargo can reuse stale executables across separate source roots when
package identities match and the second checkout has older timestamps. Compiler
caches may be shared, but Cargo build state and measurement directories are not.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys
import tomllib


SUITES = {
    "startup": "",
    "indentation": "",
    "cross_file": (
        "^cross_file_standalone_cache/|"
        "^cross_file_scope_contributions/|"
        "^cross_file_r6/|"
        "^cross_file_scope_hotspots/(nested_scope|nested_graph|nested_stream|graph_scope)/|"
        "^cross_file_diagnostic_sweep/streaming/(1|5)$"
    ),
}
REPEATS = 3
MARKER = "<!-- raven-benchmark-comparison -->"


def capture(command, cwd=None):
    return subprocess.check_output(command, cwd=cwd, text=True).strip()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def binary_hash(path):
    with path.open("rb") as binary:
        return hashlib.file_digest(binary, "sha256").hexdigest()


def build(source, label, output, toolchain):
    """Compile in a new per-revision target and copy verified Cargo artifacts."""
    target_directory = output / "build" / label
    target_directory.mkdir(parents=True, exist_ok=False)
    command = [
        "rustup", "run", toolchain, "cargo", "bench", "--locked", "-p", "raven",
        "--features", "test-support", "--no-run", "--message-format=json",
    ]
    for suite in SUITES:
        command.extend(["--bench", suite])
    env = {**os.environ, "CARGO_TARGET_DIR": str(target_directory)}
    print(f"Building {label}: {source}", flush=True)
    log_path = output / "logs" / f"{label}-build.jsonl"
    with log_path.open("w") as log, (output / "logs" / f"{label}-build.log").open("w") as errors:
        subprocess.run(command, cwd=source, env=env, stdout=log, stderr=errors, check=True)
    binaries = {}
    for line in log_path.read_text().splitlines():
        message = json.loads(line)
        if message.get("reason") != "compiler-artifact" or not message.get("executable"):
            continue
        target = message["target"]
        if "bench" in target["kind"] and target["name"] in SUITES:
            executable = Path(message["executable"]).resolve()
            if message.get("fresh") is not False or not executable.is_relative_to(target_directory.resolve()):
                raise ValueError(f"Reused or misplaced {label} benchmark artifact: {executable}")
            destination = output / "binaries" / f"{label}-{target['name']}"
            shutil.copy2(executable, destination)
            binaries[target["name"]] = destination
    if binaries.keys() != SUITES.keys():
        raise ValueError(f"Missing {label} benchmark executables: {SUITES.keys() - binaries.keys()}")
    return binaries


def read_estimates(directory):
    """Reject empty, duplicate, corrupt or non-finite Criterion measurements."""
    estimates = {}
    for path in sorted(directory.rglob("paired/estimates.json")):
        name = json.loads(path.with_name("benchmark.json").read_text())["full_id"]
        mean = json.loads(path.read_text())["mean"]
        interval = mean["confidence_interval"]
        values = (interval["lower_bound"], mean["point_estimate"], interval["upper_bound"])
        level = interval["confidence_level"]
        if (
            not all(isinstance(value, (float, int)) and math.isfinite(value) and value > 0 for value in values)
            or not values[0] <= values[1] <= values[2]
            or not isinstance(level, (float, int))
            or not 0.95 <= level <= 1
        ):
            raise ValueError(f"Invalid mean estimate: {path}")
        if name in estimates:
            raise ValueError(f"Duplicate benchmark: {name}")
        estimates[name] = {"lower": values[0], "mean": values[1], "upper": values[2]}
    if not estimates:
        raise ValueError(f"No Criterion measurements found in {directory}")
    return estimates


def measure(binaries, sources, output):
    results = {label: [] for label in binaries}
    for repeat in range(REPEATS):
        order = ("base", "candidate") if repeat % 2 == 0 else ("candidate", "base")
        current = {label: {} for label in binaries}
        # Pair each suite closely, instead of running an entire revision first.
        for suite, pattern in SUITES.items():
            for label in order:
                directory = output / "results" / str(repeat + 1) / label / suite
                directory.mkdir(parents=True)
                command = [
                    str(binaries[label][suite]), "--bench", "--warm-up-time", "1",
                    "--measurement-time", "2", "--sample-size", "20",
                    "--save-baseline", "paired", "--noplot",
                ]
                if pattern:
                    command.append(pattern)
                print(f"Measuring pair {repeat + 1}: {label}/{suite}", flush=True)
                with (output / "logs" / f"{repeat + 1}-{label}-{suite}.log").open("w") as log:
                    subprocess.run(
                        command, cwd=sources[label], check=True,
                        env={**os.environ, "CRITERION_HOME": str(directory)},
                        stdout=log, stderr=subprocess.STDOUT,
                    )
                estimates = read_estimates(directory)
                duplicates = current[label].keys() & estimates.keys()
                if duplicates:
                    raise ValueError(f"Benchmark names overlap across suites: {duplicates}")
                current[label].update(estimates)
        for label in binaries:
            results[label].append(current[label])
    return results


def compare(results, threshold):
    for label in ("base", "candidate"):
        if len(results[label]) != REPEATS or not results[label][0]:
            raise ValueError(f"Expected {REPEATS} nonempty {label} measurements")
        names = results[label][0].keys()
        if any(run.keys() != names for run in results[label]):
            raise ValueError(f"Benchmark set changed between {label} repeats")
    base_names, candidate_names = (results[label][0].keys() for label in ("base", "candidate"))
    common = base_names & candidate_names
    if not common:
        raise ValueError("No benchmarks in common between revisions")
    rows = []
    for name in sorted(common):
        base = [run[name] for run in results["base"]]
        candidate = [run[name] for run in results["candidate"]]
        ratios = [c["mean"] / b["mean"] for b, c in zip(base, candidate)]
        lower_ratios = [c["lower"] / b["upper"] for b, c in zip(base, candidate)]
        median_ratio = statistics.median(ratios)
        regression = median_ratio > 1 + threshold / 100 and min(lower_ratios) > 1
        rows.append({
            "name": name, "base_ns": statistics.median(b["mean"] for b in base),
            "candidate_ns": statistics.median(c["mean"] for c in candidate),
            "ratios": ratios, "lower_ratios": lower_ratios,
            "change_percent": (median_ratio - 1) * 100, "regression": regression,
        })
    return {
        "threshold_percent": threshold, "rows": rows,
        "added": sorted(candidate_names - base_names),
        "removed": sorted(base_names - candidate_names),
        "regressions": [row["name"] for row in rows if row["regression"]],
    }


def report(comparison, metadata):
    lines = [MARKER, "## Benchmark comparison", "",
             f"Base `{metadata['revisions']['base']}` → candidate `{metadata['revisions']['candidate']}`.", "",
             "Both revisions were built with the same Rust toolchain and measured on this runner.",
             "Three paired runs reverse order in the middle pair. No cached measurements are used.", "",
             f"The gate fails for a median slowdown above {comparison['threshold_percent']:g}% when "
             "candidate lower / base upper 95% confidence bounds exceed 1 in every pair.",
             "This is a conservative repeatability check, not a combined statistical confidence level.", "",
             "| Benchmark | Base µs | Candidate µs | Paired changes | Median change | Gate |",
             "|---|---:|---:|---|---:|---|"]
    for row in comparison["rows"]:
        changes = ", ".join(f"{(ratio - 1) * 100:+.1f}%" for ratio in row["ratios"])
        status = "FAIL" if row["regression"] else "pass"
        if not row["regression"] and row["change_percent"] > comparison["threshold_percent"]:
            status = "noisy; inspect artifact"
        lines.append(f"| `{row['name']}` | {row['base_ns'] / 1000:.2f} | "
                     f"{row['candidate_ns'] / 1000:.2f} | {changes} | {row['change_percent']:+.1f}% | {status} |")
    for category in ("added", "removed"):
        if comparison[category]:
            lines.extend(["", f"{category.capitalize()} benchmarks, not compared:"])
            lines.extend(f"- `{name}`" for name in comparison[category])
    if any(metadata.get("tracked_diff_sha256", {}).values()):
        lines.extend(["", "Tracked working-tree changes were present. Metadata includes their diff "
                      "digests; commit SHAs alone do not identify the tested source."])
    lines.extend(["", "Raw Criterion results, build/run logs, revision and CPU metadata are in the "
                  "`performance-comparison` workflow artifact.", ""])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New output directory")
    parser.add_argument("--threshold", type=float, default=5)
    args = parser.parse_args()
    if not math.isfinite(args.threshold) or args.threshold <= 0:
        parser.error("--threshold must be a finite positive percentage")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    (output / "logs").mkdir()
    (output / "binaries").mkdir()
    try:
        sources = {label: getattr(args, label).resolve() for label in ("base", "candidate")}
        toolchain = tomllib.loads((sources["candidate"] / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
        metadata = {
            "revisions": {label: capture(["git", "rev-parse", "HEAD"], source) for label, source in sources.items()},
            "rustc": capture(["rustup", "run", toolchain, "rustc", "--version", "--verbose"]),
            "platform": platform.platform(), "cpu_count": os.cpu_count(),
            "cpu": Path("/proc/cpuinfo").read_text() if Path("/proc/cpuinfo").exists() else platform.processor(),
            "suites": SUITES, "repeats": REPEATS, "threshold_percent": args.threshold,
            "environment": {name: os.environ.get(name) for name in ("RUSTFLAGS", "RUSTC_WRAPPER", "CARGO_INCREMENTAL")},
        }
        metadata["tracked_diff_sha256"] = {}
        for label, source in sources.items():
            diff = capture(["git", "diff", "--binary", "HEAD", "--"], source)
            metadata["tracked_diff_sha256"][label] = hashlib.sha256(diff.encode()).hexdigest() if diff else None
        write_json(output / "metadata.json", metadata)
        binaries = {label: build(source, label, output, toolchain) for label, source in sources.items()}
        metadata["binary_sha256"] = {
            label: {suite: binary_hash(path) for suite, path in paths.items()}
            for label, paths in binaries.items()
        }
        write_json(output / "metadata.json", metadata)
        comparison = compare(measure(binaries, sources, output), args.threshold)
        write_json(output / "report.json", comparison)
        (output / "report.md").write_text(report(comparison, metadata))
        return 1 if comparison["regressions"] else 0
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        (output / "report.md").write_text(
            f"{MARKER}\n## Benchmark comparison failed\n\n"
            "The comparison did not complete; this is a failing check.\n\n"
            f"```\n{error}\n```\n\nInspect the `performance-comparison` artifact for partial results and logs.\n"
        )
        print(f"Performance comparison failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
