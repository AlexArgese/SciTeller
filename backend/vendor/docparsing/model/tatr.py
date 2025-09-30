"""Tatr Model"""

import logging
from typing import Any
import numpy as np
from transformers import (
    AutoProcessor,
    PretrainedConfig,
)
import onnxruntime
from PIL.Image import Image
from optimum.onnxruntime.modeling_ort import ORTModel
from huggingface_hub import hf_hub_download
from ..schemas import Table

logger = logging.getLogger(__name__)


class ONNXModel(ORTModel):
    """ONNX Model

    Parameters
    ----------
    onnx_model: str
        path to the model directory

    """

    def __init__(
        self,
        onnx_model: str,
        **kwargs: dict[str, Any],
    ) -> None:
        onnx_model_path = hf_hub_download(repo_id=onnx_model, filename="model.onnx")
        try:
            config = PretrainedConfig.from_pretrained(
                onnx_model, local_files_only=True, use_fast=False
            )
            preprocessor = AutoProcessor.from_pretrained(
                onnx_model, local_files_only=True, use_fast=False
            )
        except OSError as e:
            logger.debug(
                "Error loading config locally from %s."
                " Trying to download from Hugging Face Hub : %s",
                onnx_model,
                e,
            )
            config = PretrainedConfig.from_pretrained(onnx_model, use_fast=False)
            preprocessor = AutoProcessor.from_pretrained(onnx_model, use_fast=False)

        super().__init__(
            session=onnxruntime.InferenceSession(onnx_model_path),
            config=config,
            # preprocessors=[preprocessor],
            **kwargs,
        )
        self.preprocessors = [preprocessor]

        # add no object to id2label
        self.config.id2label[len(self.config.id2label)] = "no object"
        size = self.preprocessors[0].size
        # If one of the edges is missing, set it equal to the other edge
        if "shortest_edge" in size and "longest_edge" not in size:
            size["longest_edge"] = size["shortest_edge"]
        elif "longest_edge" in size and "shortest_edge" not in size:
            size["shortest_edge"] = size["longest_edge"]
        else:
            # Set default values if both edges are missing
            self.preprocessors[0].size = {"shortest_edge": 800, "longest_edge": 800}

    def _onnx_box_cxcywh_to_xyxy(self, out_bbox: np.ndarray) -> np.ndarray:
        """bbox cxcywh to xyxy"""
        x_c, y_c, w, h = (
            out_bbox[..., 0],
            out_bbox[..., 1],
            out_bbox[..., 2],
            out_bbox[..., 3],
        )
        b = [(x_c - 0.5 * w), (y_c - 0.5 * h), (x_c + 0.5 * w), (y_c + 0.5 * h)]
        return np.stack(b, axis=1)

    def _onnx_outputs_to_objects(
        self, outputs, img_size: tuple[int, int], id_to_label: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """outputs to objects"""
        logits_softmax = np.exp(outputs[0]) / np.sum(
            np.exp(outputs[0]), axis=-1, keepdims=True
        )
        max_indices = np.argmax(logits_softmax, axis=-1)
        max_scores = np.max(logits_softmax, axis=-1)
        # Convert to lists for easier processing
        pred_labels = list(max_indices)  # List of predicted class indices
        pred_scores = list(max_scores)  # List of confidence scores
        pred_bboxes = list(outputs[1])[0]  # List of predicted bounding boxes
        pred_bboxes = [
            elem.tolist() for elem in self._onnx_box_cxcywh_to_xyxy(pred_bboxes)
        ]
        objects = []
        for label, score, bbox in zip(pred_labels[0], pred_scores[0], pred_bboxes):
            class_label = id_to_label[int(label)]
            if not class_label == "no object":
                objects.append({
                    "label": class_label,
                    "score": float(score),
                    "size": img_size,
                    "bbox": [float(elem) for elem in bbox],
                })
        return objects

    def forward(
        self,
        *_args,
        image: Image | None = None,
        **_kwargs,
    ) -> list[dict[str, Any]]:
        """predict table position"""
        # Preparing the image for the model
        image = image.convert("RGB")
        # Preprocess the image (returns pixel_values as numpy array)
        inputs = self.preprocessors[0](images=image, return_tensors="np")

        pixel_values = inputs["pixel_values"]
        if pixel_values.ndim == 5:
            pixel_values = np.squeeze(
                pixel_values, axis=1
            )  # Remove the unnecessary dimension

        # Prepare inputs for the ONNX model
        inputs_onnx = {"pixel_values": pixel_values}

        outputs = self.model.run(None, inputs_onnx)
        objects = self._onnx_outputs_to_objects(
            outputs, image.size, self.config.id2label
        )
        return objects


# Reference Notebook : https://github.com/NielsRogge/Transformers-Tutorials/blob
# /master/Table%20Transformer/Inference_with_Table_Transformer_(TATR)_for_parsing_tables.ipynb
class TatrModel:
    """Tatr Model

    Parameters
    ----------
    detection_model: str
        path to the detection model
    structure_model: str
        path to the structure model
    table_threshold: float
        confidence threshold for tables


    Examples
    --------
    ```python
    from docparsing.model import TatrModel

    # Create a TatrModel instance
    model = TatrModel()
    ```

    """

    def __init__(
        self,
        detection_model: str = "lettria/onnx-tatr-det",
        structure_model: str = "lettria/onnx-tatr-struct-v1.1-all",
        table_threshold: float = 0.5,
        **kwargs: dict[str, Any],
    ) -> None:
        self.crop_padding = 10
        self.detection_class_thresholds: dict[str, float] = {
            "table": table_threshold,
            "table rotated": 0.5,
            "no object": 10,
        }
        self.model_det = ONNXModel(onnx_model=detection_model, **kwargs)

        self.model_struct = ONNXModel(onnx_model=structure_model, **kwargs)

    def _object_to_crop(self, img: Image, obj: dict[str, Any]) -> Image | None:
        """
        Process the bounding boxes produced by the table detection model into
        cropped table images.
        """
        img_w, img_h = img.size
        if obj["score"] < self.detection_class_thresholds[obj["label"]]:
            return None
        bbox: tuple[float, float, float, float] = (
            obj["bbox"][0] * img_w - self.crop_padding,
            obj["bbox"][1] * img_h - self.crop_padding,
            obj["bbox"][2] * img_w + self.crop_padding,
            obj["bbox"][3] * img_h + self.crop_padding,
        )
        cropped_img = img.crop(bbox)
        # Comment this part cause normal table can be predicted as "table rotated"
        # If table is predicted to be rotated, rotate cropped image and tokens/words:
        # if obj["label"] == "table rotated":
        #     cropped_img = cropped_img.rotate(270, expand=True)
        return cropped_img

    def _rescale_cell(
        self,
        table: dict[str, Any],
        cell: dict[str, Any],
        cropped_size: tuple[int, int],
        image_size: tuple[int, int],
    ) -> dict[str, tuple[float, float, float, float]]:
        """rescale cell from cropped image to original image"""
        table_w, table_h = cropped_size
        img_w, img_h = image_size
        # padding used to crop table (pixel)
        padding_x = table["bbox"][0] * img_w - self.crop_padding
        padding_y = table["bbox"][1] * img_h - self.crop_padding
        # padding between 0-1 based on original image size
        padding_x = padding_x / img_w
        padding_y = padding_y / img_h
        # cell bbox from cropped size to original size (0-1)
        cell["bbox"] = [
            cell["bbox"][0] * table_w / img_w + padding_x,
            cell["bbox"][1] * table_h / img_h + padding_y,
            cell["bbox"][2] * table_w / img_w + padding_x,
            cell["bbox"][3] * table_h / img_h + padding_y,
        ]
        return cell

    def predict(
        self, image: Image, predicted_table_list: list[Table]
    ) -> list[dict[str, Any]]:
        """Predict OCR"""
        obj_tables: list[dict[str, Any]] = [
            {
                "label": "table",
                "score": table.confidence,
                "extractor": table.extractor,
                "bbox": [
                    table.x0,
                    table.y0,
                    table.x1,
                    table.y1,
                ],
            }
            for table in predicted_table_list
        ]
        predicted_tables = self.model_det(image=image)
        for table in obj_tables + predicted_tables:
            if table_img_crop := self._object_to_crop(image, table):
                predicted_cells = self.model_struct(image=table_img_crop)
                table["cells"] = [
                    self._rescale_cell(table, cell, table_img_crop.size, image.size)
                    for cell in predicted_cells
                ]
        return obj_tables + predicted_tables
