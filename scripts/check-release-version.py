#!/usr/bin/env python3
"""Verify that a release candidate is newer than every semantic-version tag on stdin."""

from __future__ import annotations

import re
import sys


SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)


def semver_key(version: str) -> tuple[object, ...]:
    match = SEMVER.fullmatch(version)
    if match is None:
        raise ValueError(f"不是受支持的语义化版本：{version}")

    major, minor, patch, prerelease = match.groups()
    if prerelease is None:
        prerelease_key: tuple[object, ...] = (1,)
    else:
        identifiers = tuple(
            (0, int(item)) if item.isdigit() else (1, item)
            for item in prerelease.split(".")
        )
        prerelease_key = (0, identifiers)
    return (int(major), int(minor), int(patch), prerelease_key)


def main() -> int:
    if len(sys.argv) != 2:
        print("用法：check-release-version.py <candidate> < versions", file=sys.stderr)
        return 2

    candidate = sys.argv[1]
    try:
        candidate_key = semver_key(candidate)
    except ValueError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 2

    versions: list[str] = []
    for line in sys.stdin:
        version = line.strip()
        if version and SEMVER.fullmatch(version):
            versions.append(version)

    if not versions:
        return 0

    latest = max(versions, key=semver_key)
    if candidate_key <= semver_key(latest):
        print(
            f"::error::候选版本 v{candidate} 必须严格高于远端最新 tag v{latest}",
            file=sys.stderr,
        )
        return 1

    print(latest, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
