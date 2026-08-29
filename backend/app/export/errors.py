class ExportError(Exception):
    """Отказ выгрузки — машинным кодом, по правилам отказов мутаций.

    Прозы здесь нет намеренно: маршрут отдаёт `code` в `detail`, а переводит
    его словарь интерфейса (см. app/mutations.py MutationError). Подписи
    внутри самого документа — другое дело, они живут в app/export/labels.py:
    документ пишет сервер, как письмо.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
