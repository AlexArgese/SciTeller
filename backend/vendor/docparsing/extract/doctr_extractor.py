"""Doctr Extractor"""

import io
from typing import Any
from .base import OCRExtractor
from ..schemas import Word, Line, WLayout, LLayout, Extractor
from ..model.doctr import DoctrModel
from ..utils import pdf_to_np_images


class DoctrExtractor(OCRExtractor):
    """Class that perform OCR extraction using Doctr model.

    Parameters

    model: DoctrModel | None
    ---------
        Doctr model to use for OCR extraction (default: None).

    image_dpi: int
    ---------
        DPI for image conversion (default: 300).

    grayscale: bool
    ---------
        Convert image to grayscale (default: False).

    Examples
    --------
    ```python
    import io
    from docparsing.extract import DoctrExtractor

    # Create a DoctrExtractor instance
    extractor = DoctrExtractor()

    # Extract words from a PDF file
    words = extractor.extract_words(io.BytesIO(open("example.pdf", "rb")))

    # Extract lines from a PDF file
    lines = extractor.extract_lines(io.BytesIO(open("example.pdf", "rb")))
    ```

    """

    def __init__(
        self,
        doctr_model: DoctrModel | None = None,
        image_dpi: int = 300,
        grayscale: bool = False,
    ):
        self.model = doctr_model if doctr_model is not None else DoctrModel()
        self.image_dpi = image_dpi
        self.grayscale = grayscale

    def _convert_to_lines(self, extract: dict[str, Any]) -> list[Line]:
        lines: list[Line | None] = []
        for page in extract["pages"]:
            for blocks in page["blocks"]:
                for line in blocks["lines"]:
                    words = [
                        Word.create(
                            x0=word["geometry"][0][0],
                            x1=word["geometry"][1][0],
                            y0=word["geometry"][0][1],
                            y1=word["geometry"][-1][1],
                            # -1 to match whether len(geometry) is 2 or 4 (for vertical words)
                            content=word["value"],
                            page=page["page_idx"],
                            extractor=Extractor.DOCTR,
                            confidence=word["confidence"],
                        )
                        for word in line["words"]
                    ]
                    words = list(filter(None, words))
                    lines.append(
                        Line.create(
                            x0=line["geometry"][0][0],
                            x1=line["geometry"][1][0],
                            y0=line["geometry"][0][1],
                            y1=line["geometry"][-1][1],
                            # -1 to match whether len(geometry) is 2 or 4
                            content=words,
                            page=page["page_idx"],
                            extractor=Extractor.DOCTR,
                        )
                    )
        return list(filter(None, lines))

    def extract_lines(self, file_content: io.BytesIO) -> LLayout:
        """Extract lines from file content using Doctr model

        Parameters
        ----------
        file_content: io.BytesIO
            File content to extract lines from

        Returns
        -------
        LLayout
            OCR Layout of extracted lines
        """
        if file_content.getbuffer().nbytes == 0:
            return LLayout([])
        lines: list[Line] = []
        images = pdf_to_np_images(file_content, self.image_dpi, self.grayscale)
        extract = self.model.predict(images)
        lines += self._convert_to_lines(extract)
        return LLayout(lines)

    def extract_words(self, file_content: io.BytesIO) -> WLayout:
        """Extract words from file content using Doctr model

        Parameters
        ----------
        file_content: io.BytesIO
            File content to extract words from

        Returns
        -------
        WLayout
            OCR Layout of extracted words
        """
        lines = self.extract_lines(file_content)
        words = [word for line in lines.root for word in line.content]
        return WLayout(words)
