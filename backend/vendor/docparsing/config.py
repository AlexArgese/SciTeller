"""Configuration for the docparsing module."""

import os
from functools import lru_cache
from pathlib import Path
from pydantic import Field, BaseModel


@lru_cache(maxsize=1)
def get_cache_dir() -> Path:
    """Get the cache directory for the detectron2 model."""
    if docparsing_cache_path := os.getenv("DOCPARSING_CACHE_PATH"):
        return Path(docparsing_cache_path)
    if lettria_cache_path := os.getenv("LETTRIA_CACHE_PATH"):
        return Path(lettria_cache_path) / "docparsing"
    else:
        return Path.home() / ".lettria" / "cache" / "docparsing"


class Config(BaseModel):
    """Configuration for the docparsing module

    Attributes
    ----------
    cache_dir : Path
        The path to the cache directory. By default, it is determined from the
        environment variables `DOCPARSING_CACHE_PATH` or `LETTRIA_CACHE_PATH`.
        If neither is set, it defaults to `Path.home() / ".lettria" / "cache" / "docparsing"`.
    """

    cache_dir: Path = Field(default_factory=get_cache_dir)


CONFIG = Config()
