from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_default_circuit_opens_ready():
    r = client.get("/api/default-circuit")
    assert r.status_code == 200
    c = r.json()
    assert c["ground"]
    assert len(c["components"]) == 4
    assert c["probes"]


def test_solve_end_to_end_reference_values():
    c = client.get("/api/default-circuit").json()
    r = client.post("/api/solve", json={
        "circuit": c,
        "sweep": {"type": "list", "points": [10.0]},
    })
    body = r.json()
    assert body["ok"] and body["ac_ok"]
    assert abs(body["operating_point"]["node_voltages"]["n_x"] - 0.516890) < 1e-5
    gain = body["frequency_response"]["probes"]["P1"]["gain_db"][0]
    assert abs(gain - (-25.8845)) < 5e-3


def test_solve_accepts_bare_circuit():
    c = client.get("/api/default-circuit").json()
    r = client.post("/api/solve", json=c)
    assert r.json()["ok"]


def test_bad_json_diagnostic():
    r = client.post("/api/solve", content=b"{not json",
                    headers={"content-type": "application/json"})
    assert r.status_code == 400
    assert r.json()["diagnostics"][0]["code"] == "BAD_JSON"


def test_failure_never_contains_curve():
    c = client.get("/api/default-circuit").json()
    c["ground"] = "ghost"
    r = client.post("/api/solve", json={"circuit": c})
    body = r.json()
    assert not body["ok"]
    assert body["frequency_response"] is None
    assert body["operating_point"] is None
    assert any(d["code"] == "UNKNOWN_NODE" for d in body["diagnostics"])


def test_source_current_sign_and_voltage_divider():
    circuit = {
        "ground": "g",
        "nodes": [{"id": "n"}, {"id": "g"}],
        "components": [
            {"id": "V1", "type": "voltage_source", "nodes": ["n", "g"],
             "params": {"dc": 2.0}},
            {"id": "Rtop", "type": "resistor", "nodes": ["n", "g"],
             "params": {"resistance": 4000.0}},
        ],
        "probes": [{"id": "P1", "plus": "n", "minus": "g"}],
    }
    body = client.post("/api/solve", json={
        "circuit": circuit, "sweep": {"type": "list", "points": [1.0]}}).json()
    assert body["ok"]
    # source delivering 0.5 mA out of its positive terminal
    assert abs(body["operating_point"]["component_currents"]["V1"] - 0.0005) < 1e-9
    # passive R to ground: unity small-signal gain at n
    assert abs(body["frequency_response"]["probes"]["P1"]["gain_db"][0]) < 1e-9
