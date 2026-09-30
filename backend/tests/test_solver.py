import pytest

from app.analysis import analyze
from app.canonical import circuit_hash
from app.default_circuit import build_default_circuit


def ref_circuit(vs=1.0):
    c = build_default_circuit()
    for comp in c["components"]:
        if comp["id"] == "V1":
            comp["params"]["dc"] = vs
    return c


def find_gain(result, probe="P1", freq=10.0):
    fr = result["frequency_response"]
    freqs = fr["freqs"]
    i = min(range(len(freqs)), key=lambda k: abs(freqs[k] - freq))
    return fr["probes"][probe]["gain_db"][i]


def test_reference_1v_operating_point_and_gain():
    r = analyze(ref_circuit(1.0), {"type": "list", "points": [10.0]})
    assert r["ok"], r["diagnostics"]
    vx = r["operating_point"]["node_voltages"]["n_x"]
    assert vx == pytest.approx(0.516890, abs=1e-5)
    assert find_gain(r) == pytest.approx(-25.8845, abs=5e-3)


def test_reference_0p6v_operating_point_and_gain():
    r = analyze(ref_circuit(0.6), {"type": "list", "points": [10.0]})
    assert r["ok"], r["diagnostics"]
    vx = r["operating_point"]["node_voltages"]["n_x"]
    assert vx == pytest.approx(0.480730, abs=1e-5)
    assert find_gain(r) == pytest.approx(-14.9859, abs=2e-3)


def test_result_is_consistent_one_circuit():
    r = analyze(ref_circuit(1.0), {"type": "log", "start": 1, "stop": 1e5, "num": 50})
    assert r["ok"]
    assert len(r["frequency_response"]["freqs"]) == 50
    for probe in r["frequency_response"]["probes"].values():
        assert len(probe["gain_db"]) == 50
        assert probe["plus"] == "n_x" and probe["minus"] == "gnd"


def test_hash_ignores_layout_and_names():
    a = ref_circuit(1.0)
    b = ref_circuit(1.0)
    b["nodes"][0]["position"] = {"x": 999, "y": 1}
    b["components"][0]["position"] = {"x": 10, "y": 10}
    b["components"][0]["name"] = "changed display name"
    assert circuit_hash(a) == circuit_hash(b)


def test_hash_changes_with_electrical_parameter():
    a = ref_circuit(1.0)
    b = ref_circuit(0.6)
    assert circuit_hash(a) != circuit_hash(b)


def test_changing_diode_changes_curve_even_with_same_topology():
    a = analyze(ref_circuit(1.0), {"type": "list", "points": [10.0]})
    c = ref_circuit(1.0)
    for comp in c["components"]:
        if comp["id"] == "D1":
            comp["params"]["saturation_current"] = 1e-9
    b = analyze(c, {"type": "list", "points": [10.0]})
    assert a["hash"] != b["hash"]
    assert abs(find_gain(a) - find_gain(b)) > 1.0


def test_missing_ground_diagnostic_points_to_node():
    c = ref_circuit()
    c["ground"] = "nope"
    r = analyze(c)
    codes = {d["code"] for d in r["diagnostics"]}
    assert "UNKNOWN_NODE" in codes
    assert r["operating_point"] is None
    assert r["frequency_response"] is None


def test_floating_node_diagnostic_points_to_real_node():
    c = build_default_circuit()
    # n_cpl reaches the rest only through a coupling capacitor -> DC undefined
    c["nodes"].append({"id": "n_cpl", "name": "隔直节点"})
    c["components"].append({
        "id": "Cc", "type": "capacitor", "nodes": ["n_cpl", "n_x"],
        "params": {"capacitance": 1e-6},
    })
    r = analyze(c, {"type": "list", "points": [10.0]})
    assert not r["ok"]
    diag = next(d for d in r["diagnostics"] if d["code"] == "FLOATING_NODE")
    assert "n_cpl" in diag["nodes"]
    # no curve must be produced for an unsolvable DC circuit
    assert r["frequency_response"] is None
    assert r["operating_point"] is None


def test_truly_disconnected_node_diagnostic():
    c = build_default_circuit()
    c["nodes"].append({"id": "n_loose", "name": "完全悬空"})
    r = analyze(c)
    diag = next(d for d in r["diagnostics"] if d["code"] == "FLOATING_NODE")
    assert "n_loose" in diag["nodes"]


def test_voltage_source_loop_is_singular_diagnostic():
    c = {
        "ground": "a",
        "nodes": [{"id": "a"}, {"id": "b"}],
        "components": [
            {"id": "V1", "type": "voltage_source", "nodes": ["a", "b"],
             "params": {"dc": 1.0}},
            {"id": "V2", "type": "voltage_source", "nodes": ["b", "a"],
             "params": {"dc": 0.5}},
        ],
        "probes": [{"id": "P1", "plus": "b", "minus": "a"}],
    }
    r = analyze(c, {"type": "list", "points": [10.0]})
    assert not r["ok"]
    assert any(d["code"] == "DC_SINGULAR" for d in r["diagnostics"])
    # failure must never fabricate curve data
    assert r["frequency_response"] is None


def test_no_input_source():
    c = {
        "ground": "a",
        "nodes": [{"id": "a"}, {"id": "b"}],
        "components": [
            {"id": "R1", "type": "resistor", "nodes": ["a", "b"],
             "params": {"resistance": 1000.0}},
        ],
        "probes": [{"id": "P1", "plus": "b", "minus": "a"}],
    }
    r = analyze(c, {"type": "list", "points": [10.0]})
    # DC is well defined (both nodes at 0V), AC needs an input source
    assert r["operating_point"] is not None
    assert r["frequency_response"] is None
    assert any(d["code"] == "NO_INPUT_SOURCE" for d in r["diagnostics"])


def test_bad_json_shape():
    r = analyze([1, 2, 3])
    assert not r["ok"]
    assert r["diagnostics"][0]["code"] == "STRUCTURE"


def test_probe_reports_its_nodes():
    r = analyze(ref_circuit(), {"type": "list", "points": [10.0]})
    probe = r["frequency_response"]["probes"]["P1"]
    assert probe["plus"] == "n_x"
    assert probe["minus"] == "gnd"
