# Hierarchy concept

# Definition

The hierarchy concept is a tree structure that organizes data into parent-child relationships.
It is calculated when converting the final docparsing Layout to XML format.

Example of a hierarchy:

```plaintext
layout
|── Header
├── Title
│   ├── Text1
│   └── Text2
└── Title2
    ├── Subtitle
    │   ├── TableCaption
    |   │   └── Table
    │   └── Text4
    └── Footer
```

In this example, the `layout` is the root node, and it has two children: `Title` and `Title2`. The `Title` node has two children: `Text1` and `Text2`. The `Title2` node has two children: `Subtitle` and `Footer`. The `Subtitle` node has two children: `TableCaption` and `Text4`, where `TableCaption` has one child: `Table`.

# Rules

The hierarchy is built based on the following rules:

1. The root node is the `layout`.
2. If a `Title` directly follows a `Title`, it is considered a child of the previous `Title` element. Else, it is a child of the `layout` element.
3. All elements are child of the previous `Title` (or `Subtitle`) element. With some exceptions:
    1. If there is no `Title` element, they are child of the `layout`.
    2. If a `TableCaption`, `FigureCaption` or `FormulaCaption` is detected, the `Table`, `Figure` or `Formula` element is child of this caption element.
    3. If a `TableFootnote` is detected, the `TableFootnote` is child of the `Table` element.
    4. If a `Text` element ends with `:` and is directly followed by a `List`, the `List` is child of this `Text` element.
    5. If the `enrichment_config.allow_cross_page_nodes` is set to `False`, the elements can't be child of the previous `Title` element if they are on different pages. this means that the elements are child of the `layout` element.
