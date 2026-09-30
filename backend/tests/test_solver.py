"""Tests pinning the solver to the independently computed reference numbers."""
import math

import pytest
from fastapi.testclient import TestClient

from app import engine
from app.main import app
from app.models import (Circuit, Device, DiodeModel, Node, Probe, Sweep)

client = TestClient(app)


def make_circuit(vdc=1.0, with_cap=True, probes=True, input_source="V1"):
    devs = [
        Device(id="V1", type="voltage_source", n1="n1", n2="gnd", dc=vdc, ac=1.0),
        Device(id="R1", type="resistor", n1="n1", n2="n2", r=1000.0),
        Device(id="D1", type="diode", n1="n2", n2="gnd",
               model=DiodeModel(isat=1e-12, vt=0.02585)),
    ]
    if with_cap:
        devs.append(Device(id="C1", type="capacitor", n1="n2", n2="gnd", c=1e-6))
    return Circuit(
        ground="gnd",
        nodes=[Node(id="gnd"), Node(id="n1"), Node(id="n2")],
        devices=devs,
        probes=[Probe(id="P1", n_plus="n2", n_minus="gnd")] if probes else [],
        input_source=input_source if probes else None,
        sweep=Sweep(start=1.0, stop=1e6, points_per_decade=200, extra=[10.0]),
    )


@pytest.mark.parametrize("vdc,ref_v,ref_db", [
    (1.0, 0.516890, -25.8845),
    (0.6, 0.480730, -14.9859),
])
def test_reference_operating_point_and_gain(vdc, ref_v, ref_db):
    r = engine.analyze(make_circuit(vdc))
    assert r["status"] == "ok"
    v = r["operating_point"]["node_voltages"]["n2"]
    assert v == pytest.approx(ref_v, abs=1e-5)

    # KCL at n2
    i_r = r["operating_point"]["device_currents"]["R1"]
    i_d = r["operating_point"]["device_currents"]["D1"]
    assert i_r == pytest.approx(i_d, abs=1e-12)

    freqs = r["ac"]["frequencies"]
    i10 = freqs.index(10.0)
    db = r["ac"]["probes"]["P1"]["magnitude_db"][i10]
    assert db == pytest.approx(ref_db, abs=1e-3)


def test_low_frequency_gain_without_capacitor_is_unity_ratio():
    r = engine.analyze(make_circuit(1.0, with_cap=False))
    db = r["ac"]["probes"]["P1"]["magnitude_db"][0]  # 1 Hz, cap negligible
    # At low frequency H(0) = (1/R)/(1/R + gd) -- the diode divider ratio.
    gd = r["operating_point"]["diode_gd"]["D1"]
    h0 = (1.0 / 1000.0) / (1.0 / 1000.0 + gd)
    assert 10 ** (db / 20.0) == pytest.approx(h0, rel=1e-4)


def test_at_high_frequency_capacitor_shorts_node_to_ground():
    r = engine.analyze(make_circuit(1.0))
    # At 1 MHz with 1 uF, |1/(sC)| ~ 0.16 ohm vs R=1k -> strongly attenuated.
    db = r["ac"]["probes"]["P1"]["magnitude_db"][-1]
    assert db < -70.0
    # And gain rolls off monotonically with frequency (more cap, more shunt).
    mags = r["ac"]["probes"]["P1"]["magnitude_db"]
    assert mags[-1] < mags[0]


def test_floating_node_is_reported_on_real_node():
    c = make_circuit()
    c.devices.append(Device(id="R2", type="resistor", n1="n3", n2="n4", r=100.0))
    c.nodes.extend([Node(id="n3"), Node(id="n4")])
    with pytest.raises(engine.CircuitError) as ei:
        engine.analyze(c)
    codes = {d["code"] for d in ei.value.diagnostics}
    assert "floating_node" in codes
    refs = {d["ref_id"] for d in ei.value.diagnostics if d["code"] == "floating_node"}
    assert refs == {"n3", "n4"}


def test_capacitor_only_branch_has_no_dc_reference():
    c = Circuit(
        ground="gnd",
        nodes=[Node(id="gnd"), Node(id="n1"), Node(id="n2"), Node(id="nx")],
        devices=[
            Device(id="V1", type="voltage_source", n1="n1", n2="gnd", dc=1.0, ac=1.0),
            Device(id="R1", type="resistor", n1="n1", n2="n2", r=1000.0),
            Device(id="D1", type="diode", n1="n2", n2="gnd",
                   model=DiodeModel(isat=1e-12, vt=0.02585)),
            Device(id="Cx", type="capacitor", n1="nx", n2="n2", c=1e-9),
        ],
    )
    with pytest.raises(engine.CircuitError) as ei:
        engine.analyze(c)
    assert any(d["code"] == "floating_node" and d["ref_id"] == "nx"
               for d in ei.value.diagnostics)


def test_dangling_terminal_references_device():
    c = make_circuit()
    c.devices.append(Device(id="R2", type="resistor", n1="n2", n2="ghost", r=10.0))
    with pytest.raises(engine.CircuitError) as ei:
        engine.analyze(c)
    assert any(d["code"] == "dangling_terminal" and d["ref_id"] == "R2"
               for d in ei.value.diagnostics)


def test_voltage_source_loop_is_singular_and_diagnosed():
    c = Circuit(
        ground="gnd",
        nodes=[Node(id="gnd"), Node(id="a")],
        devices=[
            Device(id="V1", type="voltage_source", n1="a", n2="gnd", dc=1.0),
            Device(id="V2", type="voltage_source", n1="gnd", n2="a", dc=0.5),
        ],
    )
    with pytest.raises(engine.CircuitError) as ei:
        engine.analyze(c)
    assert any(d["code"] == "voltage_source_loop" for d in ei.value.diagnostics)


def test_api_returns_consistent_package():
    resp = client.post("/api/analyze", json=make_circuit().model_dump())
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["request_hash"]
    assert body["operating_point"] is not None
    n = len(body["ac"]["frequencies"])
    for p in body["ac"]["probes"].values():
        assert len(p["magnitude_db"]) == n
        assert p["n_plus"] == "n2" and p["n_minus"] == "gnd"


def test_api_error_has_no_curves():
    c = make_circuit()
    c.devices.append(Device(id="R2", type="resistor", n1="n3", n2="n4", r=10.0))
    c.nodes.extend([Node(id="n3"), Node(id="n4")])
    body = client.post("/api/analyze", json=c.model_dump()).json()
    assert body["status"] == "error"
    assert body["ac"] is None
    assert body["operating_point"] is None
    assert body["diagnostics"]


def test_hash_tracks_electrical_content():
    from app.main import electrical_fingerprint
    a = make_circuit()
    b = make_circuit()
    assert electrical_fingerprint(a) == electrical_fingerprint(b)
    b.devices[0].dc = 0.9
    assert electrical_fingerprint(a) != electrical_fingerprint(b)
    c = make_circuit(0.6)
    assert electrical_fingerprint(a) != electrical_fingerprint(c)
