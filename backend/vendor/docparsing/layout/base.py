"""Base class for Layout Extract process"""

import abc
import io
from ..schemas import PLayout, Table


class TableLayoutExtractor(abc.ABC):
    @abc.abstractmethod
    def extract_tables(
        self, file_content: io.BytesIO, predicted_table_list: list[Table] | None = None
    ) -> PLayout: ...


class LayoutExtractor(TableLayoutExtractor):
    @abc.abstractmethod
    def extract_elements(self, file_content: io.BytesIO) -> PLayout: ...
