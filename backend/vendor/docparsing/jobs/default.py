"""Default parsing job."""

import io
import logging
import os
import asyncio
import base64
from typing import Any, Literal, TypedDict

from pydantic import AliasChoices, Field
from pydantic.json_schema import SkipJsonSchema
from pydantic_settings import BaseSettings
import vertexai
from vertexai.generative_models import GenerativeModel
from google.api_core.exceptions import GoogleAPICallError

from ..enrichment import EnrichmentConfig, LayoutModifier, MarkdownExporter, XmlExporter
from ..exceptions import (
    ManyCidError,
    ManyUnreadableCharError,
    PdfPlumberEmptyContent,
    PdfPlumberExtractionError,
)
from ..extract import DoctrExtractor, PdfPlumberExtractor
from ..layout import (
    Detectron2Extractor,
    TatrLayoutExtractor,
    YOLOv10Extractor,
    aggregate_layouts,
)
from ..model import DetectronONNXModel, DoctrModel, TatrModel, Yolov10Model, GeminiModel
from ..schemas import Extractor, LLayout, PLayout, Text, List, Title, Table, WLayout
from ..structuration import DocumentBuilder
from ..utils import load_pdf_batch, merge_layouts, is_bbox_within
from .settings import (
    AggregateLayoutsSettings,
    BuildDocumentSettings,
    Detectron2ExtractorSettings,
    Detectron2Settings,
    DoctrExtractorSettings,
    DoctrSettings,
    DocumentBuilderSettings,
    PdfPlumberSettings,
    TatrExtractorSettings,
    TatrSettings,
    Yolov10ExtractorSettings,
    Yolov10Settings,
)

logger = logging.getLogger(__name__)


class ExtractResults(TypedDict):
    """TypedDict for the results of the extraction process."""

    layout_ocr: WLayout | LLayout
    layouts: tuple[PLayout, PLayout]
    layout_tables: PLayout


class DefaultParsing(BaseSettings):
    """Default parsing job.

    Examples
    --------
    ```python
    from pydantic_settings import CliApp
    from docparsing.jobs import DefaultParsing

    parsing_job = CliApp.run(
        DefaultParsing,
        cli_args=[
            "--file-path",
            "./tests/docs/PDF/gratiszeitungen_broschuere.pdf",
            "--output-format",
            "md",
            "--no-build-document.look-for-columns",
        ],
    )

    ```
    """

    file_path: str = Field(
        description="Path to the PDF file.",
        validation_alias=AliasChoices("f", "fp", "file-path", "file_path"),
        json_schema_extra={"x-category": "core"},
    )
    output_dir: str = Field(
        ".",
        description="Output directory.",
        validation_alias=AliasChoices("o", "output-dir", "output_dir"),
        json_schema_extra={"x-category": "core"},
    )
    output_format: Literal["xml", "json", "md", "str"] = Field(
        "json",
        description="Output format.",
        validation_alias=AliasChoices("output-format", "output_format", "format"),
        json_schema_extra={"x-category": "core"},
    )
    batch_size: int = Field(
        2,
        description="Number of pages per batch while processing the PDF. "
        "0 to process the entire PDF at once.",
        json_schema_extra={"x-category": "core"},
    )
    gemini_model_name: str = Field(
        description="Name of the Gemini model to use for image parsing.",
        default="gemini-2.0-flash",
        json_schema_extra={"x-category": "core"},
    )
    transcript_image_gemini: bool = Field(
        True,
        description="Use GeminiModel for Image parsing.",
        json_schema_extra={"x-category": "core"},
    )
    export_transcript_images: bool = Field(
        False,
        description="Export transcript images to the output directory.",
        json_schema_extra={"x-category": "core"},
    )
    check_pdfplumber_alignment: bool = Field(
        True,
        description="Check if the OCR layout extracted with pdfplumber "
        "is aligned with the merged layout. "
        "If not, fall back to DoctrExtractor.",
        json_schema_extra={"x-category": "core"},
    )
    threshold_pdfplumber_alignment: float = Field(
        0.5,
        description="Threshold for OCR alignment. "
        "If the ratio of empty elements in the merged layout is greater than this value, "
        "the OCR layout will be re-extracted using DoctrExtractor.",
        json_schema_extra={"x-category": "core"},
    )
    use_doctr: bool = Field(
        False,
        description="Directly use DoctrExtractor instead of PdfPlumberExtractor "
        "without trying PdfPlumberExtractor first.",
        json_schema_extra={"x-category": "core"},
    )
    use_detectron2: bool = Field(
        False,
        description="Use Detectron2Extractor for layout extraction.",
        json_schema_extra={"x-category": "core"},
    )
    use_yolo: bool = Field(
        True,
        description="Use YOLOv10Extractor for layout extraction.",
        json_schema_extra={"x-category": "core"},
    )
    use_tatr: bool = Field(
        True,
        description="Use TatrLayoutExtractor for table extraction.",
        json_schema_extra={"x-category": "core"},
    )
    # settings
    pdfplumber: PdfPlumberSettings = Field(
        description="Settings for PdfPlumberExtractor.",
        default_factory=PdfPlumberSettings,
        json_schema_extra={"x-category": "core"},
    )
    doctr: SkipJsonSchema[DoctrSettings] = Field(
        description="Settings for DoctrExtractor.",
        default_factory=DoctrSettings,
    )
    doctr_extractor: DoctrExtractorSettings = Field(
        description="Settings for DoctrExtractor.",
        default_factory=DoctrExtractorSettings,
        json_schema_extra={"x-category": "advanced"},
    )
    detectron2: Detectron2Settings = Field(
        description="Settings for Detectron2Extractor.",
        default_factory=Detectron2Settings,
        json_schema_extra={"x-category": "core"},
    )
    detectron2_extractor: Detectron2ExtractorSettings = Field(
        description="Settings for Detectron2Extractor.",
        default_factory=Detectron2ExtractorSettings,
        json_schema_extra={"x-category": "advanced"},
    )
    yolov10: Yolov10Settings = Field(
        description="Settings for Yolov10Extractor.",
        default_factory=Yolov10Settings,
        json_schema_extra={"x-category": "core"},
    )
    yolov10_extractor: Yolov10ExtractorSettings = Field(
        description="Settings for Yolov10Extractor.",
        default_factory=Yolov10ExtractorSettings,
        json_schema_extra={"x-category": "advanced"},
    )
    tatr: TatrSettings = Field(
        description="Settings for TatrLayoutExtractor.",
        default_factory=TatrSettings,
        json_schema_extra={"x-category": "core"},
    )
    tatr_extractor: TatrExtractorSettings = Field(
        description="Settings for TatrLayoutExtractor.",
        default_factory=TatrExtractorSettings,
        json_schema_extra={"x-category": "core"},
    )
    aggregate_layouts: AggregateLayoutsSettings = Field(
        description="Settings for aggregate_layouts.",
        default_factory=AggregateLayoutsSettings,
        json_schema_extra={"x-category": "advanced"},
    )
    document_builder: DocumentBuilderSettings = Field(
        description="Settings for DocumentBuilder.",
        default_factory=DocumentBuilderSettings,
        json_schema_extra={"x-category": "core"},
    )
    build_document: BuildDocumentSettings = Field(
        description="Settings for build_document.",
        default_factory=BuildDocumentSettings,
        json_schema_extra={"x-category": "advanced"},
    )
    enrichment_config: EnrichmentConfig = Field(
        description="Enrichment configuration.",
        default_factory=EnrichmentConfig,
        json_schema_extra={"x-category": "core"},
    )

    def model_post_init(self, _context: Any) -> None:
        """Log configuration warnings on specific conditions."""
        if self.use_yolo and self.use_detectron2:
            logger.warning(
                "Both layout models selected, they will be fused together. "
                "You might want to deactivate yolo with --no-yolo to only use detectron2",
            )
        if not self.use_yolo and not self.use_detectron2:
            logger.warning(
                "No layout model selected, "
                "the OCR extraction will be used to figure out the Layout. "
                "You might want to activate at least one of the following options: "
                "--use-yolo, --use-detectron2",
            )
        if (
            self.enrichment_config.extractor_list_update_policy == "yolo"
            and not self.use_yolo
        ):
            logger.warning(
                "The extractor_list_update_policy option is set to 'yolo' "
                "but the Yolo model is not activated. "
                "You might want to activate it with --use-yolo",
            )
        if self.use_doctr and self.enrichment_config.vertical_paragraph_anchor != "no":
            logger.warning(
                "The vertical_paragraph_anchor option is set to %s "
                "but the pdfplumber model is not activated as you activated the Doctr model. "
                "So no vertical paragraph will be detected. "
                "You might want to activate pdfplumber by removing doctr with --no-use-doctr",
                self.enrichment_config.vertical_paragraph_anchor,
            )
        if (
            self.enrichment_config.xml_exporter_table_format == "latex"
            or self.enrichment_config.markdown_exporter_table_format == "latex"
        ) and self.enrichment_config.normalize_form in (
            "NFD",
            "NFKD",
        ):
            logger.warning(
                "The table format is set to 'latex' "
                "but the normalize_form is set to %s. "
                "You might want to change the normalize_form to NFC or NFKC.",
                self.enrichment_config.normalize_form,
            )

    def _extract_ocr_doctr(self, file_content: io.BytesIO):
        """Extract OCR using Doctr."""
        logger.info("Extracting OCR with Doctr...")
        doctr_model = DoctrModel(**self.doctr.model_dump())
        doctr_extractor = DoctrExtractor(
            doctr_model=doctr_model, **self.doctr_extractor.model_dump()
        )
        return doctr_extractor.extract_words(file_content)

    def _extract_ocr(self, file_content: io.BytesIO) -> WLayout:
        """Extract OCR using PdfPlumber or Doctr."""
        if self.use_doctr:
            return self._extract_ocr_doctr(file_content)
        logger.info("Extracting OCR with PdfPlumber...")
        plumber_extractor = PdfPlumberExtractor(**self.pdfplumber.model_dump())
        try:
            ret = plumber_extractor.extract_words(file_content)
            return ret
        except (
            PdfPlumberEmptyContent,
            PdfPlumberExtractionError,
            ManyCidError,
            ManyUnreadableCharError,
        ) as e:
            logger.error("%s. Fallback to DoctrExtractor", e)
            return self._extract_ocr_doctr(file_content)

    def _extract_layout_d2(self, file_content: io.BytesIO) -> PLayout:
        """Extract layout using Detectron2."""
        if not self.use_detectron2:
            return PLayout([])
        logger.info("Extracting Layout with Detectron2...")
        detectron2_model = DetectronONNXModel(**self.detectron2.model_dump())
        layout_extractor = Detectron2Extractor(
            detectron2_model=detectron2_model, **self.detectron2_extractor.model_dump()
        )
        ret = layout_extractor.extract_elements(file_content)
        return ret

    def _extract_layout_yolo(self, file_content: io.BytesIO) -> PLayout:
        """Extract layout using YOLOv10."""
        if not self.use_yolo:
            return PLayout([])
        logger.info("Extracting Layout with Yolov10...")
        yolo_model = Yolov10Model(**self.yolov10.model_dump())
        layout_extractor = YOLOv10Extractor(
            yolo_model=yolo_model, **self.yolov10_extractor.model_dump()
        )
        ret = layout_extractor.extract_elements(file_content)
        return ret

    def _extract_tables(
        self, file_content: io.BytesIO, table_list: list[Table] | None = None
    ):
        if not self.use_tatr:
            return PLayout([])
        logger.info("Extracting Tables with Tatr...")
        tatr_model = TatrModel(**self.tatr.model_dump())
        layout_table_extractor = TatrLayoutExtractor(
            tatr_model=tatr_model, **self.tatr_extractor.model_dump()
        )
        ret = layout_table_extractor.extract_tables(
            file_content, predicted_table_list=table_list
        )
        return ret

    def _process_extract(self, file_content: io.BytesIO) -> ExtractResults:
        layout_ocr = self._extract_ocr(file_content)
        layout_d2 = self._extract_layout_d2(file_content)
        layout_yolo = self._extract_layout_yolo(file_content)
        # Pop tables from layout while processing tables in Tatr
        table_list: list[Table] | None = (
            layout_yolo.get_tables(pop_tables=True)
            + layout_d2.get_tables(pop_tables=True)
            if self.use_tatr
            else None
        )
        layout_tables = self._extract_tables(file_content, table_list=table_list)
        # move tables to their respective layout
        layout_yolo += layout_tables.get_elements_by_extractor(
            Extractor.YOLO, pop_elements=True
        )
        layout_d2 += layout_tables.get_elements_by_extractor(
            Extractor.DETECTRON2, pop_elements=True
        )
        return {
            "layout_ocr": layout_ocr,
            "layouts": (layout_d2, layout_yolo),
            "layout_tables": layout_tables,
        }

    def ensure_ocr_alignment(
        self,
        file_content: io.BytesIO,
        merged_layout: PLayout,
        results: ExtractResults,
    ) -> None:
        """Ensure that the OCR layout extracted with pdfplumber
        is aligned with the merged layout Else, fall back to DoctrExtractor."""
        logger.info("Ensuring OCR alignment...")
        total_text_elements = 0
        empty_elements = 0
        for element in merged_layout.root:
            if isinstance(element, (Text, List, Title, Table)):
                if not any(
                    is_bbox_within(word, element)
                    for word in results["layout_ocr"].get_elements_by_page(element.page)
                ):
                    empty_elements += 1
                total_text_elements += 1
        if (
            total_text_elements > 0
            and empty_elements / total_text_elements
            > self.threshold_pdfplumber_alignment
        ):
            logger.warning(
                "The OCR layout is not aligned with the merged layout. "
                "%s out of %s elements are empty. "
                "Falling back to DoctrExtractor.",
                empty_elements,
                total_text_elements,
            )
            results["layout_ocr"] = self._extract_ocr_doctr(file_content)

    def _aggregate_layouts(
        self,
        layout: tuple[PLayout, PLayout],
        layout_tables: PLayout,
    ) -> PLayout:
        merged_layout = aggregate_layouts(
            layout_tables, *layout, **self.aggregate_layouts.model_dump()
        )
        return merged_layout

    def _build_document(
        self,
        layout_ocr: WLayout | LLayout,
        merged_layout: PLayout,
    ) -> PLayout:
        logger.info("Building Document...")
        document_builder = DocumentBuilder(**self.document_builder.model_dump())
        document = document_builder.build_document(
            layout_ocr, merged_layout, **self.build_document.model_dump()
        )
        return document

    def _enrich_document(self, document: PLayout, layout_modifier: LayoutModifier):
        """Enrich the parsed document."""
        logger.info("Enriching Document...")
        # Maybe call every enrichment method, some may do nothing if disabled in enrichment_config
        layout_modifier.apply_enrichment(document)

    def _dump_result(self, document: PLayout):
        """Dump the parsed document to the output directory."""
        logger.info("Dumping output files...")
        filename = self.file_path.split("/")[-1].split(".")[0]
        os.makedirs(self.output_dir, exist_ok=True)
        # Dump images
        for image in document.images:
            if "base64" in image.metadata:
                # Export images as files if export_transcript_images is True
                if self.transcript_image_gemini and self.export_transcript_images:
                    # Save the image as a file
                    os.makedirs(os.path.join(self.output_dir, "images"), exist_ok=True)
                    image_path = f"{self.output_dir}/images/{filename}_{image.id}.png"
                    with open(image_path, "wb") as img_file:
                        img_file.write(base64.b64decode(image.metadata["base64"]))
                    logger.info("Image saved in %s", image_path)
                # Remove the base64 metadata before dumping the json
                del image.metadata["base64"]
        # Dump the model configuration
        with open(
            f"{self.output_dir}/{filename}_config.json", "w", encoding="utf-8"
        ) as f:
            f.write(self.model_dump_json())
            logger.info(
                "Configuration saved in %s",
                f"{self.output_dir}/{filename}_config.json",
            )
        # Dump the parsed document
        with open(f"{self.output_dir}/{filename}.json", "w", encoding="utf-8") as f:
            f.write(document.model_dump_json())
            logger.info(
                "Document json saved in %s",
                f"{self.output_dir}/{filename}.json",
            )
        if self.output_format == "str":
            with open(f"{self.output_dir}/{filename}.txt", "w", encoding="utf-8") as f:
                f.write(document.to_str())
                logger.info(
                    "Document string saved in %s",
                    f"{self.output_dir}/{filename}.txt",
                )
            return
        if self.output_format == "json":
            return
        # Dump the parsed document in the desired format
        xml_exporter = XmlExporter(enrichment_config=self.enrichment_config)
        tree = xml_exporter.export_xml(document)
        tree.write(
            f"{self.output_dir}/{filename}.xml",
            encoding="utf-8",
            xml_declaration=True,
        )
        logger.info(
            "Document xml saved in %s",
            f"{self.output_dir}/{filename}.xml",
        )
        if self.output_format == "xml":
            return
        markdown_exporter = MarkdownExporter(enrichment_config=self.enrichment_config)
        with open(f"{self.output_dir}/{filename}.md", "w", encoding="utf-8") as f:
            f.write(markdown_exporter.export_md_from_xml(root=tree.getroot()))
            logger.info(
                "Document markdown saved in %s",
                f"{self.output_dir}/{filename}.md",
            )

    def _init_gemini(self) -> GeminiModel | None:
        try:
            vertexai.init()
            gen_model = GenerativeModel(self.gemini_model_name)
        except GoogleAPICallError as e:
            # Covers PermissionDenied, NotFound, FailedPrecondition, etc.
            logger.error("VertexAI/Gemini setup error: %s", e)
            return None
        except Exception as e:
            logger.error("Unexpected init/model error: %s", e)
            return None
        gm = GeminiModel(model=gen_model)
        logger.info("Gemini Model initialized")
        return gm

    def _create_image_transcription_tasks(
        self,
        all_tasks: dict[str, asyncio.Task[str]],
        gemini_model: GeminiModel,
        merged_layout: PLayout,
    ) -> None:
        """Create a transcription task for each image in the merged layout."""
        # start tasks for each image in the merged layout
        tasks = {
            image.id: asyncio.create_task(
                gemini_model.transcript_image(image.metadata["base64"])
            )
            for image in merged_layout.images
        }
        # Store the tasks in the all_tasks dictionary
        all_tasks.update(tasks)

    async def _apply_transcription_to_layout(
        self,
        all_tasks: dict[str, asyncio.Task[str]],
        layout_modifier: LayoutModifier,
        document: PLayout,
    ) -> None:
        """Apply the transcription results to the document layout."""
        logger.info("Transcribing %s images with Gemini...", len(all_tasks))
        # Wait for all tasks to complete and gather results
        results = await asyncio.gather(*all_tasks.values())
        # Combine results with image IDs
        responses_by_id = {
            image_id: result for image_id, result in zip(all_tasks.keys(), results)
        }
        layout_modifier.set_images_content(document, responses_by_id)

    async def default_pipeline(self) -> None:
        """Run the parsing job.
        Call the visualization between the different steps of the parsing job.
        Return the images if the output directory is not set."""
        document = PLayout([])
        doc_parts: list[tuple[PLayout, list[int]]] = []

        gemini_model = None
        if self.transcript_image_gemini:
            gemini_model = self._init_gemini()
        all_tasks: dict[str, asyncio.Task[str]] = {}
        for n, file_content in enumerate(
            load_pdf_batch(self.file_path, batch_size=self.batch_size)
        ):
            if self.batch_size > 0:
                logger.info(
                    "Processing batch %s...",
                    n + 1,
                )
            results = self._process_extract(file_content)
            merged_layout = self._aggregate_layouts(
                results["layouts"], results["layout_tables"]
            )
            if self.transcript_image_gemini and gemini_model is not None:
                self._create_image_transcription_tasks(
                    all_tasks, gemini_model, merged_layout
                )
            if not self.use_doctr and self.check_pdfplumber_alignment:
                self.ensure_ocr_alignment(file_content, merged_layout, results)
            document = self._build_document(results["layout_ocr"], merged_layout)
            if self.batch_size > 0:
                pages = list(range(n * self.batch_size, (n + 1) * self.batch_size))
                doc_parts.append((document, pages))

        if len(doc_parts) > 1:
            document = merge_layouts(*doc_parts)

        layout_modifier = LayoutModifier(enrichment_config=self.enrichment_config)
        self._enrich_document(document, layout_modifier)
        if self.transcript_image_gemini:
            await self._apply_transcription_to_layout(
                all_tasks, layout_modifier, document
            )
        document.filter_empty_elements(keep_empty_image=False)
        self._dump_result(document)

    def cli_cmd(self) -> None:
        """Run the parsing job.
        set the parsed document in the result attribute according to the output format."""
        asyncio.run(self.default_pipeline())
