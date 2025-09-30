"""Detectron2 Layout Extractor"""

import io
from .base import LayoutExtractor
from .utils import prepare_image
from ..model.detectron2 import DetectronONNXModel
from ..utils import pdf_to_np_images, pdf_to_pil_images
from ..schemas import ElementType, PLayout, Table, Image, Paragraph


class Detectron2Extractor(LayoutExtractor):
    """Class that perform Layout extraction using Detectron2 model.

    Parameters
    ----------
    detectron2_model: DetectronONNXModel | None
        Detectron2 model to use for Layout extraction (default: None).
    image_dpi: int
        DPI for image conversion (default: 300).
    grayscale: bool
        Convert image to grayscale (default: False).

    Examples
    --------
    ```python
    import io
    from docparsing.extract import Detectron2Extractor

    # Create a Detectron2Extractor instance
    extractor = Detectron2Extractor()

    # Extract elements from a PDF file
    elements = extractor.extract_elements(io.BytesIO(open("example.pdf", "rb")))

    # Extract tables from a PDF file
    tables = extractor.extract_tables(io.BytesIO(open("example.pdf", "rb")))
    ```
    """

    def __init__(
        self,
        detectron2_model: DetectronONNXModel | None = None,
        image_dpi: int = 300,
        grayscale: bool = False,
    ):
        if detectron2_model is not None:
            self.model = detectron2_model
        else:
            self.model = DetectronONNXModel()
        self.image_dpi = image_dpi
        self.grayscale = grayscale

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
        elements: list[Paragraph | Table] = []
        images = pdf_to_np_images(file_content, self.image_dpi, self.grayscale)
        for page_number, image in enumerate(images):
            elements += self.model.predict(image, page_number)
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
