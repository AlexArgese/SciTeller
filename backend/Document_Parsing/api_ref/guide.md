# Document Parsing CLI

# Default Job Usage

### Flags

-f: file path

-o: output path (optional, default: `./` )

-format: output format `json`, `md`, `xml`, `str` (optional, default: `json` )

-batch_size: max number of pdf page to process at the same time (optional, default: `None`)

--use_doctr: to use Doctr instead of pdfPlumber for text extraction (optional, default: `False`)

## Bash Example

`docparse default -f my/path/file.pdf -o tmp --format md --batch_size 2`

## Script Example

<pre><code>
from pydantic_settings import CliApp
from docparsing.jobs.parse import Parse

parsing_job = CliApp.run(
    Parse,
    cli_args=[
        "default",
        "-f",
        "my/path/file.pdf",
        "--format",
        "md",
        "-o",
        "tmp",
        "--batch_size",
        "2",
    ],
)
</code></pre>

# Debug Job Usage

### Additional Flags (optional)

--document: to show the layout at the end of the pipeline

--layout_ocr: to show the words extraction (from Doctr or PdfPlumber)

--layout_yolo: to show YOLOv10 layout prediction

--layout_detectron: to show Detectron2 layout prediction (if activated)

--layout_tatr: to show Tatr prediction on Tables

--pages: list of pages to visualize (optional, default: all pages)

--visualize.columns: to show columns used to separate layout elements within the page

--visualize.word_from_paragraph: to show words detected inside each layout elements

--visualize.draw_ocr_index: to show index of words inside each layout

--visualize.ocr_index_step: step to show words indexes (default: `10`)

## Bash Example

`docparse debug -f my/path/file.pdf --document --pages 0,1 --visualize.columns --visualize.word_from_paragraph`

## Script Example

<pre><code>
from pydantic_settings import CliApp
from docparsing.jobs.parse import Parse

parsing_job = CliApp.run(
    Parse,
    cli_args=[
        "debug",
        "-f",
        "my/path/file.pdf",
        "--format",
        "md",
        "-o",
        "tmp",
        "--batch_size",
        "2",
        "--document",
        "--pages",
        "0,1,2",
        "--visualize.columns",
        "--visualize.word_from_paragraph",
        "--visualize.draw_ocr_index",
        "--visualize.ocr_index_step",
        "2",
    ],
)
</code></pre>

### Accepted formats

- PDF (both text-based pdf and image scans)
