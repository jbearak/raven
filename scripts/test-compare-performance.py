#!/usr/bin/env python3
"""Fast tests for the performance gate; no Rust builds or timed benchmarks."""

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "compare_performance", Path(__file__).with_name("compare-performance.py")
)
PERF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PERF)


def estimate(mean, spread=0.01):
    return {"lower": mean * (1 - spread), "mean": mean, "upper": mean * (1 + spread)}


def paired(ratios, spread=0.01):
    return {
        "base": [{"scope": estimate(100, spread)} for _ in ratios],
        "candidate": [{"scope": estimate(100 * ratio, spread)} for ratio in ratios],
    }


class ComparisonTests(unittest.TestCase):
    def test_reproducible_regression_fails(self):
        comparison = PERF.compare(paired([1.08, 1.09, 1.08]), 5)
        self.assertEqual(comparison["regressions"], ["scope"])
        self.assertAlmostEqual(comparison["rows"][0]["change_percent"], 8)

    def test_small_change_improvement_and_one_noisy_pair_pass(self):
        for ratios in ([1.01, 1.02, 1.01], [0.9, 0.9, 0.9], [1.08, 0.99, 1.08]):
            with self.subTest(ratios=ratios):
                self.assertEqual(PERF.compare(paired(ratios), 5)["regressions"], [])
        self.assertEqual(PERF.compare(paired([1.08] * 3, spread=0.1), 5)["regressions"], [])

    def test_revision_speeds_are_paired_before_taking_the_median(self):
        results = paired([1.08] * 3)
        for index, duration in enumerate([100, 200, 300]):
            results["base"][index]["scope"] = estimate(duration)
            results["candidate"][index]["scope"] = estimate(duration * 1.08)
        self.assertAlmostEqual(PERF.compare(results, 5)["rows"][0]["change_percent"], 8)

    def test_added_and_removed_cases_do_not_hide_common_regressions(self):
        results = paired([1.1] * 3)
        for run in results["base"]:
            run["removed"] = estimate(200)
        for run in results["candidate"]:
            run["added"] = estimate(300)
        comparison = PERF.compare(results, 5)
        self.assertEqual(comparison["regressions"], ["scope"])
        self.assertEqual(comparison["added"], ["added"])
        self.assertEqual(comparison["removed"], ["removed"])
        markdown = PERF.report(comparison, {"revisions": {"base": "a", "candidate": "b"}})
        self.assertIn("Added benchmarks, not compared:\n- `added`", markdown)
        self.assertIn("Removed benchmarks, not compared:\n- `removed`", markdown)
        self.assertIn("FAIL", markdown)

    def test_missing_repeat_or_drifting_set_fails(self):
        results = paired([1] * 3)
        results["candidate"].pop()
        with self.assertRaisesRegex(ValueError, "Expected 3"):
            PERF.compare(results, 5)
        results = paired([1] * 3)
        results["candidate"][2].clear()
        with self.assertRaisesRegex(ValueError, "set changed"):
            PERF.compare(results, 5)

    def test_report_distinguishes_dirty_source_from_recorded_commits(self):
        comparison = PERF.compare(paired([1] * 3), 5)
        metadata = {"revisions": {"base": "a", "candidate": "b"},
                    "tracked_diff_sha256": {"base": None, "candidate": "digest"}}
        self.assertIn("Tracked working-tree changes were present", PERF.report(comparison, metadata))


class RunnerTests(unittest.TestCase):
    def test_entry_point_exit_status_and_failure_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "rust-toolchain.toml").write_text('[toolchain]\nchannel = "1.96.0"\n')
            executable = root / "binary"
            executable.write_bytes(b"test executable")
            for label, measurements, expected in (
                ("clean", paired([1.01] * 3), 0),
                ("regression", paired([1.08] * 3), 1),
                ("broken", ValueError("No measurements"), 1),
            ):
                output = root / label
                argv = ["compare-performance.py", "--base", str(root), "--candidate", str(root), "--output", str(output)]
                with patch.object(PERF.sys, "argv", argv), patch.object(PERF, "capture", return_value="test"), patch.object(PERF, "build", return_value={"startup": executable}), patch.object(PERF, "measure") as measure:
                    if isinstance(measurements, Exception):
                        measure.side_effect = measurements
                    else:
                        measure.return_value = measurements
                    self.assertEqual(PERF.main(), expected)
                self.assertTrue((output / "metadata.json").exists())
                self.assertTrue((output / "report.md").exists())
                if label == "broken":
                    self.assertIn("comparison failed", (output / "report.md").read_text())

    def test_serial_alternating_runs_use_fresh_results_and_fail_bad_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "logs").mkdir()
            executable = root / "benchmark"
            executable.write_text("""#!/usr/bin/env python3
import json, os
from pathlib import Path
label = Path.cwd().name
trace = Path(os.environ['TRACE'])
with trace.open('a') as log:
    log.write(label + '\\n')
directory = Path(os.environ['CRITERION_HOME']) / 'scope' / 'paired'
directory.mkdir(parents=True)
mean = 100 if label == 'base' else 110
(directory / 'benchmark.json').write_text(json.dumps({'full_id': 'scope'}))
(directory / 'estimates.json').write_text(json.dumps({'mean': {
    'point_estimate': mean,
    'confidence_interval': {'confidence_level': 0.95, 'lower_bound': mean - 1, 'upper_bound': mean + 1}
}}))
""")
            executable.chmod(0o755)
            sources = {label: root / label for label in ("base", "candidate")}
            for source in sources.values():
                source.mkdir()
            binaries = {label: {"startup": executable} for label in sources}
            with patch.dict(os.environ, {"TRACE": str(root / "trace")}), patch.object(PERF, "SUITES", {"startup": ""}):
                results = PERF.measure(binaries, sources, root)
            self.assertEqual((root / "trace").read_text().splitlines(), ["base", "candidate", "candidate", "base", "base", "candidate"])
            self.assertEqual(PERF.compare(results, 5)["regressions"], ["scope"])
            path = next((root / "results").rglob("paired/estimates.json"))
            for invalid in (float("nan"), 0, -1):
                data = json.loads(path.read_text())
                data["mean"]["point_estimate"] = invalid
                path.write_text(json.dumps(data))
                with self.assertRaisesRegex(ValueError, "Invalid mean"):
                    PERF.read_estimates(path.parent.parent)
            with self.assertRaisesRegex(ValueError, "No Criterion measurements"):
                PERF.read_estimates(root / "absent")

    def test_build_copies_the_reported_executable_before_target_reuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "logs").mkdir()
            (root / "binaries").mkdir()
            artifact = root / "reused-executable"

            def fake_build(command, *, cwd, env, stdout, stderr, check):
                self.assertEqual(command[:4], ["rustup", "run", "1.96.0", "cargo"])
                self.assertIn("--locked", command)
                artifact.write_text(cwd.name)
                stdout.write(json.dumps({"reason": "compiler-artifact", "target": {"name": "startup", "kind": ["bench"]}, "executable": str(artifact)}) + "\n")

            with patch.object(PERF, "SUITES", {"startup": ""}), patch.object(PERF.subprocess, "run", fake_build):
                base = PERF.build(root / "base", "base", root, "1.96.0")
                candidate = PERF.build(root / "candidate", "candidate", root, "1.96.0")
            self.assertEqual(base["startup"].read_text(), "base")
            self.assertEqual(candidate["startup"].read_text(), "candidate")


if __name__ == "__main__":
    unittest.main()
