"""Turn a title into a URL slug."""


def slugify(title: str) -> str:
    words = title.lower().split()
    return "-".join(words)
