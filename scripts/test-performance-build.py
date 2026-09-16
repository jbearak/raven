#!/usr/bin/env python3
"""Verify build isolation with real Cargo, after CI prepares Rust and its linker.

This is separate from the synthetic comparison suite used by Bun, whose job does
not prepare the Rust toolchain or compiler wrapper. The fixture has no external
dependencies and compiles two tiny benchmark executables.
"""

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "compare_performance", Path(__file__).with_name("compare-performance.py")
)
PERF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PERF)


class BuildIsolationTests(unittest.TestCase):
    def test_older_candidate_sources_build_the_candidate_code(self):
        # Real Cargo reproducer: source roots alone do not prevent reuse when
        # package/target identities match and the second checkout is older.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "logs").mkdir()
            (root / "binaries").mkdir()
            sources = {}
            for label in ("base", "candidate"):
                source = root / label
                (source / "benches").mkdir(parents=True)
                (source / "Cargo.toml").write_text(
                    '[package]\nname = "raven"\nversion = "0.0.0"\nedition = "2024"\n'
                    '[features]\ntest-support = []\n'
                    '[[bench]]\nname = "probe"\nharness = false\n'
                )
                (source / "Cargo.lock").write_text(
                    'version = 4\n[[package]]\nname = "raven"\nversion = "0.0.0"\n'
                )
                (source / "benches/probe.rs").write_text(f'fn main() {{ println!("{label}"); }}\n')
                if label == "candidate":
                    older = time.time() - 120
                    for path in source.rglob("*"):
                        if path.is_file():
                            os.utime(path, (older, older))
                sources[label] = source
            toolchain = PERF.tomllib.loads(
                (Path(__file__).resolve().parents[1] / "rust-toolchain.toml").read_text()
            )["toolchain"]["channel"]
            with patch.object(PERF, "SUITES", {"probe": ""}):
                binaries = {label: PERF.build(source, label, root, toolchain)["probe"]
                            for label, source in sources.items()}
            for label, binary in binaries.items():
                self.assertEqual(subprocess.check_output([str(binary)], text=True).strip(), label)


if __name__ == "__main__":
    unittest.main()
