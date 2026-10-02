from slug import slugify


def test_spaces_become_hyphens():
    assert slugify("Hello World") == "hello-world"


def test_lowercases():
    assert slugify("FICUS") == "ficus"
