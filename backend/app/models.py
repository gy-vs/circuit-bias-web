"""Pydantic schemas for the circuit-bias-web API.

The wire format is deliberately *electrical*: nodes, devices and how their
terminals connect.  Graphical layout is not part of this schema -- the editor
stores it elsewhere and the solver never looks at coordinates, so moving a
symbol cannot change a result.
"""
from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field

DeviceType = Literal["resistor", "capacitor", "voltage_source", "diode"]


class Node(BaseModel):
    id: str = Field(..., min_length=1)
    name: Optional[str] = None


class DiodeModel(BaseModel):
    # SI units: amperes and volts.  "is" is the wire name on both input
    # and output so fingerprints match the JSON the client actually sends.
    isat: float = Field(..., alias="is", serialization_alias="is",
                        description="reverse saturation current [A]")
    vt: float = Field(..., description="thermal voltage [V]")

    model_config = {"populate_by_name": True}


class Device(BaseModel):
    id: str = Field(..., min_length=1)
    type: DeviceType
    name: Optional[str] = None
    # Generic two-terminal connectivity.
    n1: str = Field(..., description="terminal 1 node (diode anode, source +)")
    n2: str = Field(..., description="terminal 2 node (diode cathode, source -)")
    # Exactly one of the parameter groups below applies, validated in engine.
    r: Optional[float] = Field(None, description="resistance [ohm]")
    c: Optional[float] = Field(None, description="capacitance [F]")
    dc: Optional[float] = Field(None, description="DC source voltage [V]")
    ac: Optional[float] = Field(None, description="small-signal amplitude [V]")
    model: Optional[DiodeModel] = None


class Probe(BaseModel):
    id: str = Field(..., min_length=1)
    name: Optional[str] = None
    n_plus: str
    n_minus: str


class Sweep(BaseModel):
    type: Literal["log", "linear"] = "log"
    start: float = Field(1.0, gt=0)
    stop: float = Field(1.0e6, gt=0)
    points_per_decade: int = Field(40, ge=2, le=500)
    extra: List[float] = Field(default_factory=list, description="forced freq points [Hz]")


class Circuit(BaseModel):
    version: int = 1
    ground: str
    nodes: List[Node]
    devices: List[Device]
    probes: List[Probe] = Field(default_factory=list)
    input_source: Optional[str] = None
    sweep: Sweep = Field(default_factory=Sweep)


class Diagnostic(BaseModel):
    code: str
    severity: Literal["error", "warning"]
    message: str
    ref_type: Optional[Literal["device", "node", "probe", "source"]] = None
    ref_id: Optional[str] = None


class OperatingPoint(BaseModel):
    node_voltages: Dict[str, float]
    # Positive current = current flowing INTO terminal n1 of the device.
    device_currents: Dict[str, float]
    diode_vj: Dict[str, float]
    diode_gd: Dict[str, float]


class ProbeResponse(BaseModel):
    n_plus: str
    n_minus: str
    v_real: List[float]
    v_imag: List[float]
    magnitude_db: List[float]
    phase_deg: List[float]


class ACResponse(BaseModel):
    input_source: str
    input_ac: float
    frequencies: List[float]
    probes: Dict[str, ProbeResponse]


class AnalysisMeta(BaseModel):
    newton_iterations: int
    source_steps: int
    converged: bool


class AnalysisResult(BaseModel):
    status: Literal["ok", "error"]
    request_hash: str
    operating_point: Optional[OperatingPoint] = None
    ac: Optional[ACResponse] = None
    diagnostics: List[Diagnostic] = Field(default_factory=list)
    meta: Optional[AnalysisMeta] = None
