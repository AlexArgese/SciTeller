"""Docparsing: A package for parsing visualy rich pdfs."""

from . import schemas
from .exceptions import CaptureWarningsHandler
from .utils import select_pages_pdf, merge_layouts, load_pdf_batch

elements = schemas.elements

__all__ = [
    "elements",
    "CaptureWarningsHandler",
    "select_pages_pdf",
    "merge_layouts",
    "load_pdf_batch",
]

__version__ = "1.29.0"
