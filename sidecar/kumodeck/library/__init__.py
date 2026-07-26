"""曲库层：SQLite 存储 + 扫描 + 查询/和声推荐。"""

from .db import SCHEMA_SQL, Database
from .scan import collect_files, scan_paths
from .service import (
    CAMELOT_TO_KEY,
    RELATION_LABELS,
    LibraryService,
    TrackNotFound,
    bpm_bucket,
    camelot_relations,
    normalize_path,
    parse_key_filter,
)

__all__ = [
    "CAMELOT_TO_KEY",
    "RELATION_LABELS",
    "SCHEMA_SQL",
    "Database",
    "LibraryService",
    "TrackNotFound",
    "bpm_bucket",
    "camelot_relations",
    "collect_files",
    "normalize_path",
    "parse_key_filter",
    "scan_paths",
]
