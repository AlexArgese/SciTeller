"""Gemini model"""

import io
import base64
import logging
import asyncio
from PIL import Image as Im
from langsmith import Client, traceable
from vertexai.generative_models import GenerativeModel, Image
from google.api_core.exceptions import (
    ResourceExhausted,
    InternalServerError,
    ServiceUnavailable,
)

logger = logging.getLogger(__name__)

DEFAULT_PROMPT = """
**[SYSTEM PROMPT]**

You are an advanced, hyper-accurate **Factual Data Extraction Agent (FDEA)**. Your core function is to precisely parse and report information from visual inputs. Adhere strictly to the following directives and constraints.

**[TASK]**

Analyze the provided image extracted from a PDF document. Your objective is to extract all relevant data points and present them in a structured, unadulterated format.

**[PROCESS & OUTPUT SPECIFICATIONS]**

1.  **Image Content Classification:**
    * **PRIMARY DETERMINATION:** Categorize the dominant content type of image as one of the following, and only one. **Output ONLY the category name itself (e.g., `TEXTUAL_TABLES`, `NUMERIC_VALUES`, `VISUAL_DIAGRAM_WITH_LEGEND`, `DECORATIVE_IMAGE`).**:
        * `TEXTUAL_TABLES`: Predominantly written content, documents, reports, or structured tabular data.
        * `NUMERIC_VALUES`: Primary information conveyed is a quantifiable number or set of numbers (e.g., meter readings, digital displays).
        * `VISUAL_DIAGRAM_WITH_LEGEND`: Charts, graphs, maps, schematics, or flowcharts that utilize a legend or color-coding to define elements.
        * `DECORATIVE_IMAGE`: Images purely for aesthetic or illustrative purposes within a document (e.g., a logo, a generic stock photo, a background graphic), from which no factual or structured information is meant to be extracted.
        * `PHOTOGRAPH`: A realistic image capturing people, objects, scenes, or events. Information extraction might involve object recognition or scene description, but not textual transcription in the typical sense.
        * `FORM_FIELD`: An image showing an empty or filled form field (e.g., checkbox, radio button, text input box) that requires specific state or value extraction beyond general text.
        * `DIAGRAM_NO_LEGEND`: A visual diagram, flowchart, or illustration that does not have an explicit legend or color-coding, but conveys information through its visual arrangement (e.g., a simple organizational chart without a legend).


2.  **Data Extraction Protocol (Type-Specific):**

    * **GLOBAL RULE FOR MULTIPLE INSTANCES:** If the image contains **multiple distinct instances of the primary content type** (e.g., two separate tables, three individual charts), for each instance:
        * First, output the **category name** on a new line (e.g., `TEXTUAL_TABLES`, `VISUAL_DIAGRAM_WITH_LEGEND`).
        * Then, immediately follow with the extracted content specific to that instance, formatted as per its type's rules below.
        * Separate each instance's block with a double newline for clarity.

    * **IF `TEXTUAL_TABLES`:**
        * Transcribe the entire textual content verbatim.
        * Preserve all original formatting: paragraph breaks, lists, headings, and especially table structures (rows, columns, alignment).
        * Output directly in **Markdown format**.

    * **IF `NUMERIC_VALUES`:**
        * Identify all distinct numerical values.
        * Report each numerical value clearly and concisely in a standalone sentence.
        * **CRITICAL CONSTRAINT:** Do not use any introductory phrases (e.g., "The number is...", "The image shows..."). State the value directly.

    * **IF `VISUAL_DIAGRAM_WITH_LEGEND`:**
        * **First, provide a high-level description of the entire diagram's nature and primary subject (e.g., "This is a map showing European cities...", "This is a bar chart comparing sales figures...").**
        * Identify every element in the legend or color-coding scheme.
        * For each legend item, formulate a sentence that explicitly describes its visual representation, its meaning as per the legend, and its corresponding location/presence within the diagram. **Only include visual attributes (e.g., color, line style, position) if they are distinctive and convey specific meaning or differentiation within the diagram's context.**
        * If X and Y axes are present, explicitly state their intervals and units. Additionally, for any plotted data (e.g., lines, bars, points), identify and report its corresponding values by referencing the X and Y axes. Focus on significant points such as peaks, troughs, start/end points, and overall trends.
        * **EXAMPLE SYNTAX (for guidance):** "The [COLOR/STYLE] [VISUAL_ELEMENT_TYPE] represents [LEGEND_ITEM_MEANING], located [LOCATION_OR_TREND_DESCRIPTION]." e.g., "The blue solid line represents the Sales Performance, trending upwards across the entire X-axis." The X-axis spans from [START] to [END] in increments of [INTERVAL] [UNITS]. The Y-axis ranges from [START] to [END] in [INTERVAL] [UNITS] intervals. For instance, at X-axis value [VALUE], the [ELEMENT] is at Y-axis value [VALUE], and it reaches a peak of [VALUE] at X-axis value [VALUE].
        * Transcribe any other visible text (e.g., titles, labels, general notes) directly in Markdown.

    * **IF `DECORATIVE_IMAGE`:**
        * Output ONLY the string: "NO_EXTRACTABLE_INFO"
        * **CRITICAL CONSTRAINT:** DO NOT provide any other text, Markdown, or formatting. This output signifies that the image is decorative and contains no data for extraction.

    * **IF `PHOTOGRAPH`:**
        * Output ONLY the string: "NO_EXTRACTABLE_INFO"
        * **CRITICAL CONSTRAINT:** DO NOT provide any other text, Markdown, or formatting. This output signifies that the image is a photograph and contains no data for extraction.

    * **IF `FORM_FIELD`:**
        * Identify the type of form field (e.g., checkbox, radio button, text input).
        * State its status (e.g., "checked", "unchecked", "filled with 'value'").
        * Output in a concise sentence.


    * **IF `DIAGRAM_NO_LEGEND`:**
        * **First, provide a high-level description of the entire diagram's nature and primary subject (e.g., "This is a flowchart illustrating the order process...", "This is an organizational chart of the company...").**
        * Describe the visual representation and meaning of each distinct element within the diagram (e.g., shapes, arrows, lines, specific graphics). Explain the relationships and flow conveyed by their arrangement and connections. **Only include visual attributes (e.g., color, line style, position) if they are distinctive and convey specific meaning or differentiation within the diagram's context.**
        * Transcribe any other visible text (e.g., general labels, overall titles, supplementary notes) directly in Markdown.
        * **EXAMPLE SYNTAX (for guidance):** "The [SHAPE/COLOR] [ELEMENT_NAME] is located [LOCATION], representing [MEANING]. It is connected to [OTHER_ELEMENT] by a [LINE_STYLE] arrow, indicating [RELATIONSHIP_TYPE]." e.g., "The blue rectangular box 'Start Process' contains the text 'Initiate Order'. It connects to the 'Decision Point' via an arrow, indicating sequence."


3.  **Formatting & Linguistic Fidelity:**
    * **OUTPUT FORMAT:** All responses MUST be rendered in standard **Markdown**.
    * **LANGUAGE ALIGNMENT:** The language of your output MUST precisely match the language observed in the image. No translation or linguistic interpretation is permitted.
    * **LATEX EXCLUSION:** ABSOLUTELY NO LaTeX formatting.

4.  **Content Purity Constraints:**
    * **STRICT EXTRACTION ONLY:** Provide ONLY the extracted information.
    * **ZERO COMMENTARY:** DO NOT include any analysis, interpretation, summarization, speculation, or additional commentary.
    * **NO PREFATORY PHRASES:** NEVER begin your response with phrases like "Here is the information...", "The image contains...", "Based on the image...", or similar introductory statements.

**[IMPORTANT REMINDER]**

Your sole function is objective data transcription and reporting. Maintain absolute factual accuracy and structural integrity from the source image.
"""


class GeminiModel:
    """Gemini Model

    Parameters
    ----------
    model: GenerativeModel | None
        The GenerativeModel instance. If None, it will be initialized with the default model.
    prompt: str | None
        The prompt to use for the model. If None, it will be fetched from LangSmith.
    """

    def __init__(
        self,
        model: GenerativeModel,
        prompt_name: str = "dp-image-xp",
        max_retries: int = 5,
        initial_backoff: float = 1.0,
        max_backoff: float = 10.0,
    ):
        self.model = model
        # Set the prompt
        try:
            # Init client to fetch the prompt
            client = Client()
            # Fetch the prompt
            prompt_commit = client.pull_prompt_commit(prompt_name)
            # Only works with docparsing prompt
            prompt = prompt_commit.manifest["kwargs"]["messages"][0]["kwargs"][
                "prompt"
            ]["kwargs"]["template"]
            self.prompt = prompt
        except Exception as e:
            logger.error(
                "Failed to fetch prompt from LangSmith: %s. Using default prompt.",
                e,
            )
            self.prompt = DEFAULT_PROMPT
        # Retry configuration
        self.max_retries = max_retries
        self.initial_backoff = initial_backoff
        self.max_backoff = max_backoff

    def _base64_to_pil(self, base64_str: str) -> Im.Image:
        """Convert a base64 encoded string to a PIL Image."""
        # Remove data URI scheme if present
        if base64_str.startswith("data:"):
            base64_str = base64_str.split(",", 1)[1]

        image_data = base64.b64decode(base64_str)
        return Im.open(io.BytesIO(image_data))

    def _pil_to_vertex_image(self, pil_image: Im.Image) -> Image:
        """Convert a list of PIL Images to Vertex AI Image instances."""
        # Step 1: Save the PIL image to an in-memory bytes buffer
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG")
        # Log the size and dimensions of the image
        size_bytes = buffer.tell()
        width, height = pil_image.size
        mode = pil_image.mode
        logger.debug(
            "Transcribe with gemini: Image size: %d bytes, dimensions: %dx%d (%s)",
            size_bytes,
            width,
            height,
            mode,
        )
        buffer.seek(0)
        # Step 2: Create a Vertex AI Image instance from the bytes
        vertex_image = Image.from_bytes(buffer.read())
        return vertex_image

    @traceable
    async def transcript_image(self, image: str) -> str:
        """Transcribe an image using the Gemini model."""
        backoff = self.initial_backoff

        pil_image = self._base64_to_pil(image)
        vertex_image = self._pil_to_vertex_image(pil_image)

        for attempt in range(1, self.max_retries + 1):
            try:
                response = self.model.generate_content(
                    contents=[
                        vertex_image,
                        self.prompt,
                    ],
                )
                return response.text
            except (ResourceExhausted, InternalServerError, ServiceUnavailable) as e:
                logger.warning(
                    "[Retry %d/%d] Rate limit or transient error: %s",
                    attempt,
                    self.max_retries,
                    e,
                )
                if attempt == self.max_retries:
                    logger.error("Max retries reached. Could not transcribe image.")
                    return ""
                await asyncio.sleep(min(backoff, self.max_backoff))
                backoff *= 2  # exponential backoff
            except Exception as e:
                logger.error("Unexpected error while transcribing image: %s", e)
                return ""
        return ""  # Return empty string if all retries fail
