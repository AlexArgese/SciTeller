"""Base class for Extract process"""

import abc
import io
from ..schemas import PLayout, WLayout


class OCRExtractor(abc.ABC):
    @abc.abstractmethod
    def extract_words(self, file_content: io.BytesIO) -> WLayout: ...


class TableExtractor(abc.ABC):
    @abc.abstractmethod
    def extract_tables(self, file_content: io.BytesIO) -> PLayout: ...


class Extractor(OCRExtractor, TableExtractor):
    def extract_elements(self, file_content: io.BytesIO) -> tuple[WLayout, PLayout]:
        words = self.extract_words(file_content)
        tables = self.extract_tables(file_content)
        return words, tables
