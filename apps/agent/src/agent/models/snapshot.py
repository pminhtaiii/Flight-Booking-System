from datetime import datetime
from typing import List, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class TrustedSearchResult(BaseModel):
    offerIndex: int = Field(gt=0)
    flightOfferId: str
    duffelOfferId: str
    airline: str
    origin: str
    destination: str
    departureAt: datetime
    arrivalAt: datetime
    price: str
    currency: str

    model_config = ConfigDict(extra="forbid")


class TrustedSearchSnapshot(BaseModel):
    schemaVersion: Literal[1]
    snapshotVersion: int = Field(gt=0)
    userId: str
    sessionId: str
    createdAt: datetime
    expiresAt: datetime
    fingerprint: str
    selectionAttestation: str
    results: List[TrustedSearchResult] = Field(min_length=1, max_length=5)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_results_indexes(self) -> "TrustedSearchSnapshot":
        if self.results:
            indexes = [r.offerIndex for r in self.results]
            expected = list(range(1, len(self.results) + 1))
            if indexes != expected:
                raise ValueError("Result indexes must be unique and contiguous from 1")
        return self
