# Split Candidate concept

# Definition

The Split Candidate concept is a mechanism used to identify potential split points in a document layout. It is set as a value where 0 is the highest priority, and the value increases as the priority decreases. The Split Candidate is used to determine how to split a document into smaller sections or elements based on their layout and content.

It is calculated when converting the final docparsing Layout to XML format. It is also written as a commentary before each element in the Markdown output.

The markdown comments are in JSON format and contains:

- `split_candidate`: The split candidate priority value.
- `type`: The type of the element (e.g., text, table, title).
- `page`: The page number(s) of the element. (e.g., [0], [1, 2]).
- `bbox`: The bounding box coordinates of the element. (e.g., [[0.1, 0.2, 0.3, 0.4]]). The coordinates are in the format [x0, y0, x1, y1], where (x0, y0) is the top-left corner and (x1, y1) is the bottom-right corner of the bounding box.

# Example of a markdown with Split Candidate

```plaintext
<!-- {"split_candidate": 4, "type": "text", "page": [0], "bbox": [[0.11603, 0.47761, 0.8678, 0.54779]]} -->
## Title of the section

<!-- {"split_candidate": 4, "type": "text", "page": [0], "bbox": [[0.11588, 0.56244, 0.87728, 0.66807]]} -->
Content of the text element
```

# Rules

The Split Candidate is built based on the following rules:

1. The Split Candidate is set to 0 at each first page element.
2. The first Title of the document is set to 0. The others Title elements are set to 1 and they increase by 1 for each consecutive Title element. The maximum value is set by the variable MAX_TITLE_SPLIT_CANDIDATE (6).
3. The Split Candidate of Paragraph elements (i.e., not a Title element) are set by the value of their parent in the hierarchy, increased by 1. They can't be lower than the variable MIN_PARAGRAPH_SPLIT_CANDIDATE (4). Unless it is the first element of the page, in which case it is set to 0.
