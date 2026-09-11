class ExportError(Exception):
    """An export refusal, as a machine code, following the mutation refusal rules.

    There is deliberately no prose here: the route returns `code` in `detail`,
    and the interface's dictionary translates it (see app/mutations.py
    MutationError). Labels inside the document itself are another matter — they
    live in app/export/labels.py: the server writes the document the way it
    writes a letter.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
