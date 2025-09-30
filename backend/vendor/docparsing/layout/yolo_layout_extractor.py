"""YOLO Layout Extractor"""

from typing import Any
import io
from .base import LayoutExtractor
from .utils import prepare_image
from ..schemas import (
    PLayout,
    ElementType,
    Table,
    Text,
    Title,
    Extra,
    Image,
    Extractor,
    AutoPlayoutElement,
)
from ..model.yolo import Yolov10Model
from ..utils import pdf_to_np_images, pdf_to_pil_images


class YOLOv10Extractor(LayoutExtractor):
    """Class that perform Layout extraction using YOLOv10 model.

    Parameters
    ----------
    yolo_model: Yolov10Model | None
        YOLOv10 model to use for Layout extraction (default: None).
    image_dpi: int
        DPI for image conversion (default: 300).
    grayscale: bool
        Convert image to grayscale (default: False).

    Examples
    --------
    ```python
    import io
    from docparsing.layout import YOLOv10Extractor

    # Create a YOLOv10Extractor instance
    extractor = YOLOv10Extractor()

    # Extract elements from a PDF file
    elements = extractor.extract_elements(io.BytesIO(open("example.pdf", "rb")))

    # Extract tables from a PDF file
    tables = extractor.extract_tables(io.BytesIO(open("example.pdf", "rb")))
    ```

    """

    LABEL2CLASS: dict[str, type[AutoPlayoutElement]] = {
        "table": Table,
        "title": Title,
        "figure_caption": Title,
        "table_caption": Title,
        "formula_caption": Title,
        "plain text": Text,
        "abandon": Extra,
        "table_footnote": Text,
        "isolate_formula": Text,
        "figure": Image,
    }

    def __init__(
        self,
        yolo_model: Yolov10Model | None = None,
        image_dpi: int = 300,
        grayscale: bool = False,
    ):
        if yolo_model is not None:
            self.model = yolo_model
        else:
            self.model = Yolov10Model()
        self.image_dpi = image_dpi
        self.grayscale = grayscale

    @property
    def label2class(self):
        """Label to Class mapping"""
        return self.__class__.LABEL2CLASS

    def _convert_to_element(
        self, extract: list[dict[str, Any]], page: int
    ) -> list[AutoPlayoutElement]:
        """Convert result to element"""
        elements: list[AutoPlayoutElement | None] = []
        for res in extract:
            if res["name"] == "table":
                elements.append(
                    Table.create(
                        x0=res["box"]["x1"],
                        y0=res["box"]["y1"],
                        x1=res["box"]["x2"],
                        y1=res["box"]["y2"],
                        cells=[],
                        page=page,
                        confidence=res["confidence"],
                        extractor=Extractor.YOLO,
                    )
                )
            elif res["name"] in [
                "title",
                "figure_caption",
                "table_caption",
                "formula_caption",
                "plain text",
                "table_footnote",
                "isolate_formula",
                "abandon",
                "figure",
            ]:
                elements.append(
                    self.label2class[res["name"]].create(
                        x0=res["box"]["x1"],
                        y0=res["box"]["y1"],
                        x1=res["box"]["x2"],
                        y1=res["box"]["y2"],
                        content=[],
                        page=page,
                        confidence=res["confidence"],
                        extractor=Extractor.YOLO,
                        label=res["name"],
                    )
                )
        return list(filter(None, elements))

    def extract_elements(self, file_content: io.BytesIO) -> PLayout:
        """Extract elements from file content using Detectron2 model

        Parameters
        ----------
        file_content: io.BytesIO
            File content to extract elements from.

        Returns
        -------
        PLayout
            Layout of extracted elements (paragraphs and tables without content).
        """
        elements: list[AutoPlayoutElement] = []
        images = pdf_to_np_images(file_content, self.image_dpi, self.grayscale)
        for page_number, image in enumerate(images):
            extract = self.model.predict(image)
            elements += self._convert_to_element(extract, page_number)
        if any(isinstance(element, Image) for element in elements):
            # using cache
            pil_images = pdf_to_pil_images(file_content, self.image_dpi, self.grayscale)
            # set id and crop image as vertex image
            prepare_image(elements, pil_images)
        return PLayout(elements)

    def extract_tables(
        self, file_content: io.BytesIO, _predicted_table_list: list[Table] | None = None
    ) -> PLayout:
        """Extract tables from file content using Detectron2 model

        Parameters
        ----------
        file_content: io.BytesIO
            File content to extract tables from.

        Returns
        -------
        PLayout
            Layout of extracted tables without content
        """
        elements = self.extract_elements(file_content)
        return PLayout(
            [element for element in elements.root if element.type == ElementType.TABLE]
        )
