from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Candidate(Record):
    title: str
    originalTitle: str
    author: str
    isbn: str
    category: str
    score: int = Field(ge=75, le=100)
    reason: str
    queries: list[str] = Field(min_length=2, max_length=3)


class Candidates(Record):
    candidates: list[Candidate] = Field(min_length=3, max_length=3)


class Source(Record):
    id: str
    url: str
    title: str
    institution: str
    first_party: bool
    supports: list[str] = Field(min_length=1)


class Research(Record):
    sources: list[Source] = Field(min_length=5, max_length=8)
    cover_url: str
    cover_source_url: str
    cover_edition: str
    cover_usage_basis: str


class CoverChoice(Record):
    url: str
    source_url: str
    edition: str
    usage_basis: str


class Example(Record):
    type: Literal["事实案例", "书中/作者案例", "合成情境"]
    text: str
    source_ids: list[str]


class SOP(Record):
    trigger: str
    inputs: str
    steps: list[str] = Field(min_length=4, max_length=6)
    output: str
    stop: str


class Insight(Record):
    title: str
    judgment: str
    mechanism: str
    boundary: str
    examples: list[Example] = Field(min_length=2, max_length=2)
    sop: SOP
    question: str


class Claim(Record):
    text: str
    source_ids: list[str] = Field(min_length=1)


class Draft(Record):
    title: str
    originalTitle: str
    author: str
    description: str
    tags: list[str] = Field(min_length=3, max_length=3)
    category: str
    value: str
    reading_map: str
    insights: list[Insight] = Field(min_length=5, max_length=5)
    plan: list[str] = Field(min_length=7, max_length=7)
    criticism: str
    copyright: str
    claims: list[Claim] = Field(min_length=5)


class Judgment(Record):
    id: str
    passed: bool
    evidence: str = Field(min_length=10)


class Review(Record):
    checks: list[Judgment]
