class JiraError(Exception):
    """Jira did not answer, answered with a refusal, or answered unexpectedly.

    The machine-readable `code` is the same separation as in LlmError: the
    human gets a code translated through a dictionary on the client, while
    `message` stays for the developer's log.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
