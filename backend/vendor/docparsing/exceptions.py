"""Custom exceptions for the docparsing package."""

import logging


# Create a custom log handler to capture logs
class CaptureWarningsHandler(logging.Handler):
    """Custom log handler to capture warnings."""

    def __init__(self):
        super().__init__()
        self.warnings: list[str] = []  # Store captured warnings here

    def emit(self, record: logging.LogRecord) -> None:
        # Only capture warning level logs
        if record.levelno == logging.WARNING:
            self.warnings.append(self.format(record))


class ManyCidError(Exception):
    """Custom exception for CID errors."""

    def __init__(self, message: str = "CID error detected"):
        super().__init__(message)


class ManyUnreadableCharError(Exception):
    """Custom exception for unreadable characters errors."""

    def __init__(self, message: str = "Too many unreadable characters detected"):
        super().__init__(message)


class CoordinatesError(Exception):
    """Custom exception for coordinates errors."""

    def __init__(self, message: str = "Coordinates error detected"):
        super().__init__(message)


class PdfPlumberExtractionError(Exception):
    """
    Raised when pdfplumber encounters an error during PDF extraction.
    This might occur if the PDF is corrupt, password-protected,
    or if there are issues with the pdfplumber library itself.
    """

    def __init__(self, message: str = "An error occurred during PDF extraction"):
        self.message = message
        super().__init__(self.message)


class PdfPlumberEmptyContent(Exception):
    """
    Raised when pdfplumber cannot extract readable content from the PDF.
    This might occur if the PDF is image-based, corrupt, or not a valid PDF.
    """

    def __init__(self, message: str = "No readable content found in the PDF"):
        self.message = message
        super().__init__(self.message)
