#!/usr/bin/env python3
"""Regression checks for the release gate's published rcN naming scheme."""
import pathlib
import subprocess
import sys
import unittest


class ReleaseVersionTests(unittest.TestCase):
    def test_release_gate(self):
        for candidate, existing, accepted in [
            ("1.0.0-rc10", ["1.0.0-rc8", "1.0.0-rc9"], True),
            ("1.0.0-rc9", ["1.0.0-rc10"], False),
            ("1.0.0-rc20", ["1.0.0-rc19"], True),
            ("1.0.0-rc10", ["1.0.0-rc10"], False),
            ("1.0.0-rc10", ["1.0.0-rc.10"], False),
            ("1.0.0", ["1.0.0-rc10"], True),
            ("1.0.0-rc10", ["1.0.0"], False),
            ("1.0.0-rc10", ["1.0.1-rc1"], False),
        ]:
            with self.subTest(candidate=candidate, existing=existing):
                result = subprocess.run(
                    [sys.executable, str(pathlib.Path(__file__).with_name("check-release-version.py")), candidate],
                    input="\n".join(existing), text=True, capture_output=True,
                )
                self.assertEqual(result.returncode, 0 if accepted else 1, result.stderr)


if __name__ == "__main__":
    unittest.main()
