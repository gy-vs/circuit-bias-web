"""The circuit the workbench opens with: Vs(1V) - R(1k) - node with diode
and 1 uF capacitor to ground - the reference circuit described in the spec.

Positions are graphical only; they never enter the electrical fingerprint.
"""
from __future__ import annotations


def build_default_circuit() -> dict:
    return {
        "format": "circuit-bias-web/1",
        "ground": "gnd",
        "nodes": [
            {"id": "n_src", "name": "源输出", "position": {"x": 120, "y": 233}},
            {"id": "n_x", "name": "电阻后节点", "position": {"x": 407, "y": 220}},
            {"id": "gnd", "name": "地", "position": {"x": 610, "y": 367}},
        ],
        "components": [
            {
                "id": "V1",
                "type": "voltage_source",
                "name": "V1 1V",
                "nodes": ["n_src", "gnd"],
                "params": {"dc": 1.0, "ac_mag": 1.0, "ac_phase": 0.0},
                "position": {"x": 120, "y": 300},
                "orientation": "vertical",
            },
            {
                "id": "R1",
                "type": "resistor",
                "name": "R1 1k",
                "nodes": ["n_src", "n_x"],
                "params": {"resistance": 1000.0},
                "position": {"x": 340, "y": 220},
                "orientation": "horizontal",
            },
            {
                "id": "D1",
                "type": "diode",
                "name": "D1",
                "nodes": ["n_x", "gnd"],
                "params": {"saturation_current": 1e-12, "thermal_voltage": 0.02585},
                "position": {"x": 488, "y": 300},
                "orientation": "vertical",
            },
            {
                "id": "C1",
                "type": "capacitor",
                "name": "C1 1u",
                "nodes": ["n_x", "gnd"],
                "params": {"capacitance": 1e-6},
                "position": {"x": 570, "y": 300},
                "orientation": "vertical",
            },
        ],
        "probes": [
            {"id": "P1", "name": "电阻后节点电压", "plus": "n_x", "minus": "gnd"},
        ],
    }
