"""Default parsing job."""

import io
import os
import logging
import asyncio
from typing import Any
from pydantic import Field
from ..schemas import PLayout, LLayout, WLayout
from ..utils import load_pdf_batch, merge_layouts
from ..visualization import Visualization
from .default import DefaultParsing, ExtractResults
from .settings import VisualizeSettings
from ..enrichment.layout_modifier import LayoutModifier

logger = logging.getLogger(__name__)


class DefaultDebug(DefaultParsing):
    """Default parsing job with visualization options.

    Examples
    --------
    ```python
    debug_job = CliApp.run(
        DefaultDebug,
        cli_args=[
            "--file-path",
            "./tests/docs/PDF/gratiszeitungen_broschuere.pdf",
            "--output-dir",
            "./visu",
            "--use-doctr",
            "--document",
            "--pages",
            "0,1",
            "--visualize.word-from-paragraph",
            "--visualize.draw-ocr-index",
            "--visualize.columns",
        ],
    )
    ```

    """

    layout_ocr: bool = Field(
        default=False,
        description="Visualize OCR layout predicted by OCR model.",
        json_schema_extra={"x-category": "core"},
    )
    layout_tatr: bool = Field(
        default=False,
        description="Visualize Table layout predicted by TATR model.",
        json_schema_extra={"x-category": "core"},
    )
    layout_detectron: bool = Field(
        default=False,
        description="Visualize layout predicted by Detectron model.",
        json_schema_extra={"x-category": "core"},
    )
    layout_yolo: bool = Field(
        default=False,
        description="Visualize layout predicted by Yolo model.",
        json_schema_extra={"x-category": "core"},
    )
    document: bool = Field(
        default=False,
        description="Visualize the final document.",
        json_schema_extra={"x-category": "core"},
    )
    pages: list[int] = Field(
        default_factory=lambda: [],
        description="List of pages to visualize.",
        json_schema_extra={"x-category": "advanced"},
    )
    visualize: VisualizeSettings = Field(
        default_factory=VisualizeSettings,
        description="Visualization settings.",
        json_schema_extra={"x-category": "core"},
    )

    def model_post_init(self, context: Any) -> None:
        """Log configuration warnings on specific conditions."""
        super().model_post_init(context)
        if (
            not self.layout_ocr
            and not self.layout_tatr
            and not self.layout_detectron
            and not self.layout_yolo
            and not self.document
        ):
            logger.warning(
                "No visualization option selected, "
                "the debug job will not produce any visualization. "
                "You might want to activate at least one of the following options: "
                "--layout-ocr, --layout-tatr, --layout-detectron, --layout-yolo, --document",
            )
        if self.layout_tatr and not self.use_tatr:
            logger.warning(
                "The layout_tatr visualization is enabled "
                "but the TATR model is not activated. "
                "You might want to activate it with --use-tatr",
            )
        if self.layout_detectron and not self.use_detectron2:
            logger.warning(
                "The layout_detectron visualization is enabled "
                "but the Detectron2 model is not activated. "
                "You might want to activate it with --use-detectron2",
            )
        if self.layout_yolo and not self.use_yolo:
            logger.warning(
                "The layout_yolo visualization is enabled "
                "but the Yolo model is not activated. "
                "You might want to activate it with --use-yolo",
            )

    def _visualize_layout(
        self,
        file_content: io.BytesIO,
        layout: PLayout | LLayout | WLayout,
        pages: list[int] | None = None,
        page_offset: int = 0,
        full_layout: bool = False,
        suffix: str = "",
    ) -> None:
        """Set the output directory and
        Visualize the layout of the document."""
        logger.info("Dump Visualization...")
        # Dump the parsed document
        filename = self.file_path.split("/")[-1].split(".")[0]
        os.makedirs(os.path.join(self.output_dir, "source-debug"), exist_ok=True)
        out = os.path.join(self.output_dir, "source-debug", filename + suffix)

        visualization = Visualization(**self.visualize.model_dump())

        visualization.draw_layouts(
            layout,
            file_content=io.BytesIO(file_content.getvalue()),
            pages=pages,
            page_offset=page_offset,
            full_layout=full_layout,
            out=out,
        )
        # Dump the layout in JSON format
        if suffix != "_document":
            with open(
                f"{self.output_dir}/{filename}{suffix}_{page_offset}.json",
                "w",
                encoding="utf-8",
            ) as f:
                f.write(layout.model_dump_json())

    def _call_visu(
        self,
        file_content: io.BytesIO,
        results: ExtractResults,
        batch_num: int,
    ) -> None:
        """Select pages to visualize and
        Call visualization for each layout whether it is activated or not."""
        page_to_visu: list[int] | None = None
        if self.pages:
            if self.batch_size <= 0:
                page_to_visu = self.pages
            else:
                page_to_visu: list[int] | None = []
                for page in self.pages:
                    if page in range(
                        batch_num * self.batch_size, (batch_num + 1) * self.batch_size
                    ):
                        page_to_visu.append(page)

        if self.layout_ocr:
            self._visualize_layout(
                file_content,
                results["layout_ocr"],
                page_to_visu,
                page_offset=batch_num * self.batch_size if self.batch_size > 0 else 0,
                full_layout=False,
                suffix="_ocr",
            )
        if self.layout_tatr:
            self._visualize_layout(
                file_content,
                results["layout_tables"],
                page_to_visu,
                page_offset=batch_num * self.batch_size if self.batch_size > 0 else 0,
                full_layout=False,
                suffix="_tatr",
            )
        if self.layout_detectron:
            self._visualize_layout(
                file_content,
                results["layouts"][0],
                page_to_visu,
                page_offset=batch_num * self.batch_size if self.batch_size > 0 else 0,
                full_layout=False,
                suffix="_detectron",
            )
        if self.layout_yolo:
            self._visualize_layout(
                file_content,
                results["layouts"][1],
                page_to_visu,
                page_offset=batch_num * self.batch_size if self.batch_size > 0 else 0,
                full_layout=False,
                suffix="_yolo",
            )

    async def debug_pipeline(self):
        """Run the parsing job.
        call the visualization between the different steps of the parsing job.
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
            self._call_visu(file_content, results, n)
            merged_layout = self._aggregate_layouts(
                results["layouts"], results["layout_tables"]
            )
            if self.transcript_image_gemini and gemini_model is not None:
                self._create_image_transcription_tasks(
                    all_tasks,
                    gemini_model,
                    merged_layout,
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

        for n, file_content in enumerate(
            load_pdf_batch(self.file_path, batch_size=self.batch_size)
        ):
            if self.document:
                self._visualize_layout(
                    file_content,
                    document,
                    self.pages if self.pages else None,
                    page_offset=n * self.batch_size if self.batch_size > 0 else 0,
                    full_layout=True,
                    suffix="_document",
                )

    def cli_cmd(self) -> None:
        """Run the debug pipeline."""
        asyncio.run(self.debug_pipeline())
