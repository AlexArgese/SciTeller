"""Tatr Extractor"""

from typing import Any
import io

from .base import TableLayoutExtractor
from ..schemas import Table, Cell, PLayout, Extractor, Bbox
from ..model import TatrModel
from ..utils import pdf_to_pil_images, is_bbox_within, calculate_intersection_area


class TatrLayoutExtractor(TableLayoutExtractor):
    """Tatr Extractor for Table Layout Extraction using TATR model.

    Parameters
    ----------
    tatr_model: TatrModel | None
        TATR model to use for Layout extraction (default: None).
    spanning_cell_overlap_threshold: float
        Threshold for spanning cell overlap detection (default: 0.5).
    image_dpi: int
        DPI for image conversion (default: 300).
    grayscale: bool
        Convert image to grayscale (default: False).

    Examples
    --------
    ```python
    import io
    from docparsing.extract import TatrExtractor

    # Create a TatrExtractor instance
    extractor = TatrExtractor()

    # Extract tables from a PDF file
    tables = extractor.extract_tables(io.BytesIO(open("example.pdf", "rb")))
    ```

    """

    def __init__(
        self,
        tatr_model: TatrModel | None = None,
        spanning_cell_overlap_threshold: float = 0.5,
        header_threshold: float = 0.8,
        image_dpi: int = 300,
        grayscale: bool = False,
    ):
        self.model = tatr_model if tatr_model is not None else TatrModel()
        self.overlap_threshold = spanning_cell_overlap_threshold
        self.header_threshold = header_threshold
        self.image_dpi = image_dpi
        self.grayscale = grayscale

    def _filter_grid(
        self,
        table: dict[str, Any],
    ) -> None:
        """from prediction list, remove overlapping cells rows and columns based on threshold"""
        to_remove: list[Any] = []
        for n, cell1 in enumerate(table["cells"]):
            bbox1 = Bbox.create(
                x0=cell1["bbox"][0],
                x1=cell1["bbox"][2],
                y0=cell1["bbox"][1],
                y1=cell1["bbox"][3],
            )
            if bbox1 is None:
                continue
            for cell2 in table["cells"][n + 1 :]:
                bbox2 = Bbox.create(
                    x0=cell2["bbox"][0],
                    x1=cell2["bbox"][2],
                    y0=cell2["bbox"][1],
                    y1=cell2["bbox"][3],
                )
                if (
                    bbox2 is not None
                    and is_bbox_within(
                        bbox1, bbox2, overlap_threshold=self.overlap_threshold
                    )
                    and (
                        (
                            cell1["label"] == "table row"
                            and cell2["label"] == "table row"
                        )
                        or (
                            cell1["label"] == "table column"
                            and cell2["label"] == "table column"
                        )
                    )
                ):
                    to_remove.append(
                        cell1 if cell1["score"] < cell2["score"] else cell2
                    )
        for cell in to_remove:
            if cell in table["cells"]:
                table["cells"].remove(cell)

    def convert_to_cells(
        self,
        rows: list[dict[str, Any]],
        columns: list[dict[str, Any]],
        headers: list[Bbox],
        page_number: int,
    ) -> list[Cell]:
        """Convert rows and columns to cells based on their bounding boxes,
        - using only x0 of the N row and N+1 row and y0 of the N column and N+1 column
        - using headers to determine if a cell is a header or not."""
        cells: list[Cell] = []
        for n_row, row in enumerate(rows):
            for n_col, col in enumerate(columns):
                x0 = col["bbox"][0]
                x1 = (
                    columns[n_col + 1]["bbox"][0]
                    if len(columns) > n_col + 1
                    else col["bbox"][2]
                )
                y0 = row["bbox"][1]
                y1 = (
                    rows[n_row + 1]["bbox"][1]
                    if len(rows) > n_row + 1
                    else row["bbox"][3]
                )
                confidence = (row["score"] + col["score"]) / 2
                cell = Cell.create(
                    x0=x0,
                    x1=x1,
                    y0=y0,
                    y1=y1,
                    label="cell",
                    page=page_number,
                    confidence=confidence,
                    extractor=Extractor.TATR,
                )
                if cell is not None:
                    if any(
                        is_bbox_within(
                            cell, header, overlap_threshold=self.overlap_threshold
                        )
                        for header in headers
                    ):
                        cell.metadata["label"] = "cell_header"
                    cells.append(cell)
        return cells

    def convert_to_spanning_cells(
        self,
        cells: list[Cell],
        spans: list[dict[str, Any]],
        page_number: int,
    ) -> None:
        """using spanning cells to replace all the cells that are within the spanning cell
        so the spanning cell object will be several times in the list"""
        for span in spans:
            spanning_cell = Cell.create(
                x0=span["bbox"][0],
                x1=span["bbox"][2],
                y0=span["bbox"][1],
                y1=span["bbox"][3],
                label="spanning_cell",
                page=page_number,
                confidence=span["score"],
                extractor=Extractor.TATR,
            )
            if spanning_cell is not None:
                # Set spanning cell candidate in metadata for each cell that overlaps with it
                # to choose the spanning cell with the highest overlap
                for cell in cells:
                    overlap = (
                        calculate_intersection_area(cell, spanning_cell) / cell.area
                    )
                    if overlap > self.overlap_threshold:
                        # If the cell is not already a spanning candidate
                        # or if the overlap is greater than the current candidate,
                        # update the spanning candidate metadata
                        if (
                            "spanning_candidate" not in cell.metadata
                            or overlap > cell.metadata["spanning_candidate"][0]
                        ):
                            cell.metadata["spanning_candidate"] = (
                                overlap,
                                spanning_cell,
                            )
        # Replace cells with spanning cells based on the spanning candidate metadata
        for cell in cells:
            if "spanning_candidate" in cell.metadata:
                spanning_cell = cell.metadata["spanning_candidate"][1]
                if cell.label in ["cell_header", "spanning_header"]:
                    spanning_cell.metadata["label"] = "spanning_header"
                cells.insert(cells.index(cell), spanning_cell)
                cells.remove(cell)

    def _make_cells(self, table: dict[str, Any], page_number: int) -> list[Cell]:
        """Create cells list from prediction output:
        filter overlapping rows and columns,
        split cells by label into rows, columns, headers and spanning cells
        convert rows and columns to cells based on their bounding boxes
        modify labels of cells based on their overlap with headers predictions
        and spanning cells predictions"""
        if "cells" not in table:
            return []
        self._filter_grid(table)
        rows = sorted(
            [cell for cell in table["cells"] if "table row" == cell["label"]],
            key=lambda x: x["bbox"][1],
        )
        columns = sorted(
            [cell for cell in table["cells"] if "table column" == cell["label"]],
            key=lambda x: x["bbox"][0],
        )
        headers = list(
            filter(
                None,
                [
                    Bbox.create(
                        x0=cell["bbox"][0],
                        x1=cell["bbox"][2],
                        y0=cell["bbox"][1],
                        y1=cell["bbox"][3],
                    )
                    for cell in table["cells"]
                    if cell["label"]
                    in ["table projected row header", "table column header"]
                    and cell["score"] > self.header_threshold
                ],
            )
        )
        cells = self.convert_to_cells(rows, columns, headers, page_number)
        spans = sorted(
            [cell for cell in table["cells"] if "table spanning cell" == cell["label"]],
            key=lambda x: (x["bbox"][1], x["bbox"][0]),
        )
        self.convert_to_spanning_cells(cells, spans, page_number)
        return cells

    def _snap_cells_to_table_bbox(
        self,
        cells: list[Cell],
        table_bbox: list[float],
    ) -> None:
        """Snap the edge of cells on X to the table bbox
        Snap the edge of the table on Y to the min and max of the cells"""
        if cells:
            epsilon = 1e-2
            min_x0 = min(cell.x0 for cell in cells)
            max_x1 = max(cell.x1 for cell in cells)
            # snap X
            for cell in cells:
                if min_x0 - epsilon < cell.x0 < min_x0 + epsilon:
                    cell.x0 = table_bbox[0]
                if max_x1 - epsilon < cell.x1 < max_x1 + epsilon:
                    cell.x1 = table_bbox[2]
            # snap Y
            table_bbox[1] = min(cell.y0 for cell in cells)
            table_bbox[3] = max(cell.y1 for cell in cells)

    def _convert_to_tables(
        self, extract: list[dict[str, Any]], page_number: int = 0
    ) -> list[Table]:
        tables: list[Table | None] = []
        for table in extract:
            cells = self._make_cells(table, page_number=page_number)
            self._snap_cells_to_table_bbox(
                cells,
                table["bbox"],
            )
            tables.append(
                Table.create(
                    x0=table["bbox"][0],
                    x1=table["bbox"][2],
                    y0=table["bbox"][1],
                    y1=table["bbox"][3],
                    cells=cells,
                    page=page_number,
                    confidence=table["score"],
                    extractor=table.get("extractor", Extractor.TATR),
                )
            )
        return list(filter(None, tables))

    def extract_tables(
        self, file_content: io.BytesIO, predicted_table_list: list[Table] | None = None
    ) -> PLayout:
        """Extract tables from file content using TATR model

        Parameters
        ----------
        file_content: io.BytesIO
            PDF file content to extract tables from

        Returns
        -------
        PLayout
            Layout of extracted tables without content
        """
        tables: list[Table] = []

        image_list = pdf_to_pil_images(file_content, self.image_dpi, self.grayscale)
        for page_number, image in enumerate(image_list):
            page_predicted_tables = []
            if predicted_table_list is not None:
                page_predicted_tables = [
                    table for table in predicted_table_list if table.page == page_number
                ]
            extract = self.model.predict(
                image,
                predicted_table_list=page_predicted_tables,
            )
            tables += self._convert_to_tables(extract, page_number=page_number)
        return PLayout(tables)
