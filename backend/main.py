import os
import sys
import math
import csv
import hashlib
import io
import json
import time
import threading
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from typing import Optional

# Add trajectory simulator paths relative to this backend script
# The simulator is in the parent directory
parent_dir = os.path.dirname(os.path.dirname(__file__))
sim_dir = os.path.join(parent_dir, "skill-vis:MyTrajectorySimulator-main")
sys.path.insert(0, sim_dir)
sys.path.insert(0, os.path.join(sim_dir, "API"))

import numpy as np
from MyBallTrajectorySim import BallTrajectorySimulator2, IntegrationMethod, PitchParameters, EnvironmentParameters
from statcast_to_sim import statcast_to_sim_params


class FullBallTrajectorySimulator(BallTrajectorySimulator2):
    """
    Enhanced BallTrajectorySimulator2 subclass that:
    1. Uses standard aerodynamic constant and Nathan exponential lift model matching MyBallTrajectorySim_E.
    2. Integrates through y <= 0.0m (past home plate) so front and mid plate crossings are available.
    3. Records crossing metrics at both front (y = 0.4318m) and mid plate (y = 0.2159m).
    4. Adds numerical clipping guards against floating point domain errors in spin calculations.
    5. Applies small vertical (backspin) and horizontal (sidespin) lift
       calibrations so the simulated plate position matches Hawk-Eye pX/pZ.
    6. Projects the gyro (rifle) spin out of the Magnus cross product so only
       the transverse (backspin/sidespin) spin produces lift (Nathan's intent).

    Lift calibration (Statcast plate-fit): comparing the RK4 sim against the
    9-param Statcast fit on live-feed data (backend/diag_vertical_bias.py), the
    sim lands ~0.7 in low at the plate on average. Inputs (release height, 50-ft
    kinematics) are exonerated: the sim matches Statcast at y=50 ft to <0.01 in,
    and flight time/plate speed match the 9P fit to <1 ms / <0.5 mph. The deficit
    is a ~0.16 m/s^2 shortfall in vertical aero lift (Magnus), so the vertical
    Magnus term is scaled by LIFT_SCALE; the horizontal (sidespin) Magnus term is
    scaled separately by SIDESPIN_SCALE (fit across venues).

    Gyro-spin fix: the gyro spin is reconstructed along the *release* velocity
    and held fixed in space, so as the trajectory curves downward under gravity
    the frozen gyro vector developed a spurious sideways Magnus term
    (``wy * vz``) that added a constant ~+0.7 in x offset between 50 ft and the
    plate. ``simulate`` stores the release-velocity spin component in
    ``self._gyro_spin`` and ``calculate_acceleration`` subtracts it before the
    Magnus cross product, so gyro spin contributes nothing. Verified across 15
    venues: signed x error collapses from ~+0.7 in to ~0 in.
    """
    # Both re-fit across 15 venues after the gyro fix (backend/fit_calibration.py).
    # LIFT_SCALE is a bias/scatter compromise: signed-bias min is ~1.10, absolute
    # |z|/|tot| error min is ~1.00; 1.05 keeps the bias inside the regression
    # bound (-0.29 in) without the breaking-pitch scatter blow-up.
    LIFT_SCALE = 1.05       # vertical (backspin) lift calibration
    SIDESPIN_SCALE = 0.95   # horizontal (sidespin) calibration (min |x| and |mean x|)
    RECORD_FORCES = False   # diagnostic: record per-step drag/magnus components

    def sidespin_scale(self, rho: float) -> float:
        """Horizontal (sidespin) Magnus scale for the given air density.

        Fitted across 15 venues (backend/fit_sidespin_scale.py) after restoring
        full-density spin recovery. Per-venue optimal scales show no correlation
        with air density (0.60-1.11 scatter over rho 0.97-1.22), so the fit
        collapses to a constant ~0.95 which minimizes mean |x| error. (The
        constant ~+0.7 in x offset previously left over is not a sidespin issue;
        it was the frozen gyro-spin Magnus term, removed by projecting gyro spin
        out of the cross product — see calculate_acceleration.)
        """
        return self.SIDESPIN_SCALE

    def calculate_const(self, rho: float) -> float:
        return 0.5 * rho * (math.pi * self.radius_m**2) / self.mass_kg

    def calculate_lift_coefficient(self, romega: float, v_rel: float, t: float) -> float:
        S = (romega / v_rel) * self._spin_decay_factor(v_rel, t) if v_rel > 0 else 0
        return 0.336 * (1.0 - math.exp(-6.041 * S))

    def calculate_drag_coefficient(self, v_rel: float, spin_eff: float, t: float) -> float:
        spin_term = self.cdspin * spin_eff / 1000
        decay_term = self._spin_decay_factor(v_rel, t)
        return self.cd0 + spin_term * decay_term

    def calculate_acceleration(self, state, t, pitch, env, const, rho, romega_initial):
        x, y, z = state[0], state[1], state[2]
        vx, vy, vz = state[3], state[4], state[5]
        wx, wy, wz = state[6], state[7], state[8]
        spin_total = state[9]
        omega_total = state[10]

        v = math.sqrt(vx**2 + vy**2 + vz**2)

        # Wind
        if z >= env.hwind_m:
            vxw = env.vwind_mph * 0.44704 * math.sin(math.radians(env.phiwind_deg))
            vyw = env.vwind_mph * 0.44704 * math.cos(math.radians(env.phiwind_deg))
        else:
            vxw = vyw = 0

        v_rel = math.sqrt((vx - vxw)**2 + (vy - vyw)**2 + vz**2)

        flag = 1
        spin_dot_v = (wx * vx + wy * vy + wz * vz) / v if v > 0 else 0
        spin_eff_sq = max(0.0, spin_total**2 - flag * (self.rad_per_sec_to_rpm * spin_dot_v)**2)
        spin_eff = math.sqrt(spin_eff_sq) if v > 0 else spin_total

        romega = (spin_eff * self.rpm_to_rad_per_sec) * self.radius_m
        cd = self.calculate_drag_coefficient(v_rel, spin_eff, t)
        cl = self.calculate_lift_coefficient(romega, v_rel, t)

        if v_rel > 0:
            drag_x = -const * cd * v_rel * (vx - vxw)
            drag_y = -const * cd * v_rel * (vy - vyw)
            drag_z = -const * cd * v_rel * vz
        else:
            drag_x = drag_y = drag_z = 0

        if v_rel > 0 and omega_total > 0 and romega > 0:
            X = romega / romega_initial if romega_initial > 0 else 1.0
            vx_rel = vx - vxw if z >= env.hwind_m else vx
            vy_rel = vy - vyw if z >= env.hwind_m else vy
            # Gyro (rifle) spin produces no Magnus: subtract the release-velocity
            # component of the spin so only the transverse (backspin/sidespin)
            # spin enters the cross product. Holding the frozen gyro vector fixed
            # in space added a spurious ~+0.7 in x offset as the trajectory
            # curved downward (wy * vz term); projecting it out removes it.
            gx, gy, gz = getattr(self, '_gyro_spin', (0.0, 0.0, 0.0))
            wx_t = wx - gx
            wy_t = wy - gy
            wz_t = wz - gz
            magnus_x = const * (cl / omega_total) * v_rel * (wy_t * vz - wz_t * vy_rel) / X
            magnus_y = const * (cl / omega_total) * v_rel * (wz_t * vx_rel - wx_t * vz) / X
            magnus_z = const * (cl / omega_total) * v_rel * (wx_t * vy_rel - wy_t * vx_rel) / X
            magnus_x *= self.sidespin_scale(rho)  # horizontal (sidespin) calibration
            magnus_z *= self.LIFT_SCALE      # vertical (backspin) lift calibration
        else:
            magnus_x = magnus_y = magnus_z = 0

        if self.RECORD_FORCES:
            self._dbg_forces.append((t, y, rho, cd, spin_eff,
                                     drag_x, drag_y, drag_z,
                                     magnus_x, magnus_y, magnus_z,
                                     wy, wz, vy, vz))

        ax = drag_x + magnus_x
        ay = drag_y + magnus_y
        az = drag_z + magnus_z - self.g

        return np.array([ax, ay, az])

    def simulate(self, pitch=None, env=None, max_time=1.0, save_interval=1):
        if pitch is None:
            pitch = PitchParameters()
        if env is None:
            env = EnvironmentParameters()

        v0 = pitch.v0_mps
        v0x = pitch.v0_mps * math.cos(math.radians(pitch.theta_deg)) * math.sin(math.radians(pitch.phi_deg))
        v0y = -pitch.v0_mps * math.cos(math.radians(pitch.theta_deg)) * math.cos(math.radians(pitch.phi_deg))
        v0z = pitch.v0_mps * math.sin(math.radians(pitch.theta_deg))

        if pitch.wx_rad_s is not None:
            wx, wy, wz = pitch.wx_rad_s, pitch.wy_rad_s, pitch.wz_rad_s
            omega_norm_rads = math.sqrt(wx * wx + wy * wy + wz * wz)
            spin_total = omega_norm_rads * self.rad_per_sec_to_rpm + 0.001
            omega_dot_v_hat = (wx * v0x + wy * v0y + wz * v0z) / v0 if v0 > 0 else 0
            omega_total = math.sqrt(max(0.0, omega_norm_rads**2 - omega_dot_v_hat**2)) + 0.001
        else:
            spin_total = math.sqrt(pitch.backspin_rpm**2 + pitch.sidespin_rpm**2 + pitch.wg_rpm**2) + 0.001
            omega_total = math.sqrt(pitch.backspin_rpm**2 + pitch.sidespin_rpm**2) * self.rpm_to_rad_per_sec + 0.001
            wx = (-pitch.backspin_rpm * math.cos(math.radians(pitch.phi_deg)) -
                  pitch.sidespin_rpm * math.sin(math.radians(pitch.theta_deg)) * math.sin(math.radians(pitch.phi_deg)) +
                  pitch.wg_rpm * v0x / v0) * self.rpm_to_rad_per_sec
            wy = (pitch.backspin_rpm * math.sin(math.radians(pitch.phi_deg)) -
                  pitch.sidespin_rpm * math.sin(math.radians(pitch.theta_deg)) * math.cos(math.radians(pitch.phi_deg)) +
                  pitch.wg_rpm * v0y / v0) * self.rpm_to_rad_per_sec
            wz = (pitch.sidespin_rpm * math.cos(math.radians(pitch.theta_deg)) +
                  pitch.wg_rpm * v0z / v0) * self.rpm_to_rad_per_sec

        # Gyro (rifle) spin = the component of the spin vector along the release
        # velocity. It produces no Magnus force, so it is removed from the spin
        # used in the Magnus cross product (see calculate_acceleration).
        ux, uy, uz = v0x / v0, v0y / v0, v0z / v0
        spin_dot_u = wx * ux + wy * uy + wz * uz
        self._gyro_spin = (spin_dot_u * ux, spin_dot_u * uy, spin_dot_u * uz)

        temp_C = (5/9) * (env.temp_F - 32)
        rho = self.calculate_air_density(temp_C, env.elev_m, env.relative_humidity, env.pressure_mmHg)
        const = self.calculate_const(rho)
        romega_initial = omega_total * self.radius_m

        state = np.array([
            pitch.x0, pitch.y0, pitch.z0,
            v0x, v0y, v0z,
            wx, wy, wz,
            spin_total, omega_total
        ], dtype=float)

        self.trajectory = []
        self.home_plate_crossing = None
        self.home_plate_crossing_front = None
        self.home_plate_crossing_mid = None
        self._dbg_forces = []

        t = 0.0
        x, y, z = state[0], state[1], state[2]
        vx, vy, vz = state[3], state[4], state[5]
        v = math.sqrt(vx**2 + vy**2 + vz**2)

        acc0 = self.calculate_acceleration(state, t, pitch, env, const, rho, romega_initial)

        self.trajectory.append({
            't': t, 'x': x, 'y': y, 'z': z,
            'vx': vx, 'vy': vy, 'vz': vz,
            'ax': acc0[0], 'ay': acc0[1], 'az': acc0[2],
            'v': v, 'v_mph': v / 0.44704,
            'distance': math.sqrt(x**2 + y**2), 'height': z,
        })

        step = 0
        front_y = 0.4318
        mid_y = 0.2159

        while t < max_time and y >= 0.0:
            if self.integration_method == IntegrationMethod.RK4:
                state = self.rk4_step(state, t, self.dt, pitch, env, const, rho, romega_initial)
            elif self.integration_method == IntegrationMethod.NATHAN:
                state = self.nathan_step(state, t, self.dt, pitch, env, const, rho, romega_initial)
            else:
                state = self.euler_step(state, t, self.dt, pitch, env, const, rho, romega_initial)

            x, y, z = state[0], state[1], state[2]
            vx, vy, vz = state[3], state[4], state[5]
            wx, wy, wz = state[6], state[7], state[8]
            v = math.sqrt(vx**2 + vy**2 + vz**2)
            acc = self.calculate_acceleration(state, t + self.dt, pitch, env, const, rho, romega_initial)

            prev_pt = self.trajectory[-1]
            prev_y = prev_pt['y']

            # Check front crossing (0.4318m)
            if prev_y > front_y and y <= front_y and self.home_plate_crossing_front is None:
                frac = (front_y - prev_y) / (y - prev_y) if (y - prev_y) != 0 else 0
                self.home_plate_crossing_front = {
                    't': prev_pt['t'] + frac * self.dt,
                    'x': prev_pt['x'] + frac * (x - prev_pt['x']),
                    'y': front_y,
                    'z': prev_pt['z'] + frac * (z - prev_pt['z']),
                    'vx': prev_pt['vx'] + frac * (vx - prev_pt['vx']),
                    'vy': prev_pt['vy'] + frac * (vy - prev_pt['vy']),
                    'vz': prev_pt['vz'] + frac * (vz - prev_pt['vz']),
                }

            # Check mid crossing (0.2159m)
            if prev_y > mid_y and y <= mid_y and self.home_plate_crossing_mid is None:
                frac = (mid_y - prev_y) / (y - prev_y) if (y - prev_y) != 0 else 0
                self.home_plate_crossing_mid = {
                    't': prev_pt['t'] + frac * self.dt,
                    'x': prev_pt['x'] + frac * (x - prev_pt['x']),
                    'y': mid_y,
                    'z': prev_pt['z'] + frac * (z - prev_pt['z']),
                    'vx': prev_pt['vx'] + frac * (vx - prev_pt['vx']),
                    'vy': prev_pt['vy'] + frac * (vy - prev_pt['vy']),
                    'vz': prev_pt['vz'] + frac * (vz - prev_pt['vz']),
                }

            if step % save_interval == 0:
                self.trajectory.append({
                    't': t + self.dt, 'x': x, 'y': y, 'z': z,
                    'vx': vx, 'vy': vy, 'vz': vz,
                    'ax': acc[0], 'ay': acc[1], 'az': acc[2],
                    'v': v, 'v_mph': v / 0.44704,
                    'distance': math.sqrt(x**2 + y**2), 'height': z,
                })

            t += self.dt
            step += 1

        self.home_plate_crossing = self.home_plate_crossing_front or (self.trajectory[-1] if self.trajectory else None)
        return self.trajectory


# ---------------------------------------------------------------------------
# Default / baseline EnvironmentParameters (MLB neutral-site conditions)
# Used for A/B comparison against live weather pulled from the Stats API.
# ---------------------------------------------------------------------------
DEFAULT_ENV = EnvironmentParameters(
    temp_F=70.0,          # standard warm-day temperature
    elev_m=4.572,         # 15 ft – rough MLB average field elevation
    relative_humidity=50.0,
    pressure_mmHg=760.0,  # sea-level baseline
    vwind_mph=0.0,
    phiwind_deg=0.0,
    hwind_m=0.0,
)

DEFAULT_ENV_META = {
    "temp_F": 70.0,
    "elev_ft": 15,
    "elev_m": 4.572,
    "condition": "Standard (default)",
    "relative_humidity_pct": 50.0,
    "wind_note": "Default baseline – no live weather used",
    "venue_name": "Neutral",
    "roof_type": "N/A",
}


# ---------------------------------------------------------------------------
# MLB weather/venue → EnvironmentParameters
# ---------------------------------------------------------------------------

# Sky condition string → approximate relative humidity (%)
# MLB API returns strings like "Clear", "Cloudy", "Partly Cloudy", "Rain", "Roof Closed"
_CONDITION_HUMIDITY: dict[str, float] = {
    "clear": 35.0,
    "sunny": 35.0,
    "partly cloudy": 50.0,
    "cloudy": 60.0,
    "overcast": 65.0,
    "drizzle": 80.0,
    "rain": 85.0,
    "snow": 75.0,
    "roof closed": 50.0,
    "dome": 50.0,
}

def _estimate_humidity(condition: str) -> float:
    """Map an MLB sky-condition string to an approximate relative humidity %."""
    key = condition.strip().lower()
    for pattern, humidity in _CONDITION_HUMIDITY.items():
        if pattern in key:
            return humidity
    return 50.0  # sensible default when condition is unknown


# Open-Meteo historical archive (free, no API key) supplies observed barometric
# pressure and relative humidity. The MLB Stats API live feed has no pressure or
# humidity fields — its ``weather`` block only carries condition/temp/wind — so
# these must come from here.
OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
HPA_TO_MMHG = 0.750061683  # 1 hPa = 0.750061683 mmHg (760 mmHg = 1013.25 hPa)


def _parse_game_dt_utc(game_data: dict):
    """Parse the game's first-pitch ``dateTime`` into an aware UTC datetime."""
    raw = (game_data.get("datetime") or {}).get("dateTime")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _fetch_observed_weather(latitude, longitude, game_dt_utc):
    """
    Fetch observed weather at the venue for the hour of first pitch from
    Open-Meteo's archive, keyed to venue coordinates.

    Returns a small dict (``surface_pressure_hpa``, ``pressure_msl_hpa``,
    ``relative_humidity_pct``) or ``None`` on any failure, so callers can fall
    back to the elevation-derived station pressure and sky-condition humidity
    without breaking the endpoint.
    """
    if latitude is None or longitude is None or game_dt_utc is None:
        return None
    try:
        day = game_dt_utc.strftime("%Y-%m-%d")
        hour_label = game_dt_utc.replace(
            minute=0, second=0, microsecond=0
        ).strftime("%Y-%m-%dT%H:00")
        resp = requests.get(
            OPEN_METEO_ARCHIVE_URL,
            params={
                "latitude": latitude,
                "longitude": longitude,
                "start_date": day,
                "end_date": day,
                "hourly": "surface_pressure,pressure_msl,relative_humidity_2m",
                "timezone": "UTC",
            },
            timeout=10,
        )
        resp.raise_for_status()
        hourly = resp.json().get("hourly", {})
        times = hourly.get("time", [])
        if hour_label not in times:
            return None
        idx = times.index(hour_label)

        def _value(key):
            values = hourly.get(key)
            if not values or values[idx] is None:
                return None
            return float(values[idx])

        return {
            "surface_pressure_hpa": _value("surface_pressure"),
            "pressure_msl_hpa": _value("pressure_msl"),
            "relative_humidity_pct": _value("relative_humidity_2m"),
        }
    except Exception:
        return None


def fetch_environment_params(game_data: dict, observed: bool = True) -> tuple[EnvironmentParameters, dict]:
    """
    Extract weather and venue data from the MLB Stats API ``gameData`` block
    and return a populated :class:`EnvironmentParameters` instance.

    Barometric pressure & humidity:
        The MLB feed exposes no pressure or humidity field, so observed values
        come from Open-Meteo's historical archive at the venue coordinates and
        first-pitch hour.  We pass the observed *surface* pressure (already
        measured at venue altitude) with ``elev_m=0`` so the simulator's own
        ``exp(-beta * elev_m)`` altitude term is a no-op and altitude is not
        double-counted.  If Open-Meteo is unreachable, we fall back to
        reducing standard sea-level pressure (760 mmHg) to venue altitude and
        estimating humidity from the sky-condition string.

    Wind is intentionally ignored (zeroed):
    - Pitches fly at 2-5 ft, well below stadium wall height.
    - Batted ball trajectories are quadratic estimates from hit-point to
      landing, not full aerodynamic simulations, so wind would only add noise.

    Parameters
    ----------
    game_data : dict
        The ``gameData`` sub-object from the MLB live-feed JSON response.
    observed : bool
        When True (default), fetch observed pressure/humidity from Open-Meteo.
        When False, use the elevation-derived pressure and sky-condition
        humidity fallback (the pre-Open-Meteo behaviour).

    Returns
    -------
    (EnvironmentParameters, dict)
        The populated environment params and a raw metadata dict for the
        API response payload.
    """
    weather = game_data.get("weather", {})
    venue   = game_data.get("venue", {})
    location = venue.get("location", {})

    # --- Temperature ---
    try:
        temp_F = float(weather.get("temp", 70))
    except (TypeError, ValueError):
        temp_F = 70.0

    # --- Elevation: venue reports feet ---
    elev_ft = location.get("elevation", 15)  # 15 ft ≈ MLB average field level
    try:
        elev_m_real = float(elev_ft) * 0.3048
    except (TypeError, ValueError):
        elev_m_real = 4.572  # 15 ft default

    # --- Indoor (roof-closed / dome) games: no outdoor weather to model ---
    # A closed roof means the ball flew through climate-controlled air, so the
    # venue's outdoor pressure/humidity/temperature are irrelevant. Return
    # neutral conditions (mirroring DEFAULT_ENV) instead of Open-Meteo's outdoor
    # readings, which would otherwise make indoor games look worse than the
    # neutral baseline for no physical reason.
    condition_str = weather.get("condition", "")
    condition_lower = condition_str.strip().lower()
    if ("roof closed" in condition_lower or "dome" in condition_lower
            or "indoor" in condition_lower):
        env = EnvironmentParameters(
            temp_F=70.0,
            elev_m=4.572,               # 15 ft, matching DEFAULT_ENV
            relative_humidity=50.0,
            pressure_mmHg=760.0,
            vwind_mph=0.0,
            phiwind_deg=0.0,
            hwind_m=0.0,
        )
        metadata = {
            "temp_F": 70.0,
            "elev_ft": elev_ft,
            "elev_m": round(elev_m_real, 2),
            "pressure_station_mmHg": 760.0,
            "pressure_source": "neutral (indoor)",
            "condition": condition_str or "Unknown",
            "relative_humidity_pct": 50.0,
            "humidity_source": "neutral (indoor)",
            "wind_note": "Indoor (roof closed) — neutral conditions, no live weather",
            "venue_name": venue.get("name", "Unknown"),
            "roof_type": venue.get("fieldInfo", {}).get("roofType", "Unknown"),
        }
        return env, metadata

    # --- Barometric pressure ---
    # Preferred: observed surface pressure from Open-Meteo at the venue.
    # Fallback: reduce standard sea-level pressure (760 mmHg) to venue altitude.
    # Surface pressure is already at venue altitude, so elev_m=0 below keeps the
    # simulator from applying a second exp(-beta*elev_m) correction.
    BETA = 0.0001217  # must match BallTrajectorySimulator2.beta
    pressure_station_mmHg = 760.0 * math.exp(-BETA * elev_m_real)
    pressure_source = "elevation-derived (fallback)"

    obs_weather = None
    if observed:
        coords = location.get("defaultCoordinates") or {}
        game_dt_utc = _parse_game_dt_utc(game_data)
        obs_weather = _fetch_observed_weather(
            coords.get("latitude"), coords.get("longitude"), game_dt_utc
        )
    if obs_weather and obs_weather.get("surface_pressure_hpa") is not None:
        pressure_station_mmHg = obs_weather["surface_pressure_hpa"] * HPA_TO_MMHG
        pressure_source = "Open-Meteo (observed surface pressure)"

    # --- Humidity: observed from Open-Meteo, fallback to sky-condition estimate ---
    relative_humidity = _estimate_humidity(condition_str)
    humidity_source = "sky-condition estimate (fallback)"
    if obs_weather and obs_weather.get("relative_humidity_pct") is not None:
        relative_humidity = obs_weather["relative_humidity_pct"]
        humidity_source = "Open-Meteo (observed)"

    # --- Wind: zeroed out deliberately (see docstring) ---
    vwind_mph  = 0.0
    phiwind_deg = 0.0
    hwind_m    = 0.0

    env = EnvironmentParameters(
        temp_F=temp_F,
        elev_m=0.0,                      # altitude already baked into pressure
        relative_humidity=relative_humidity,
        pressure_mmHg=pressure_station_mmHg,  # station pressure at venue altitude
        vwind_mph=vwind_mph,
        phiwind_deg=phiwind_deg,
        hwind_m=hwind_m,
    )

    metadata = {
        "temp_F": temp_F,
        "elev_ft": elev_ft,
        "elev_m": round(elev_m_real, 2),
        "pressure_station_mmHg": round(pressure_station_mmHg, 2),
        "pressure_source": pressure_source,
        "condition": condition_str or "Unknown",
        "relative_humidity_pct": relative_humidity,
        "humidity_source": humidity_source,
        "wind_note": "Ignored — pitches below stadium wall height; batted balls are quadratic estimates",
        "venue_name": venue.get("name", "Unknown"),
        "roof_type": venue.get("fieldInfo", {}).get("roofType", "Unknown"),
    }

    return env, metadata

app = FastAPI()

# Allow CORS for local frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In production, restrict this!
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Default game (used when the frontend hasn't picked a live game yet). The
# drawer lets the user pick any currently-live game, which the frontend then
# passes as ``game_pk`` on every endpoint.
GAME_PK = '822774'


def _feed_url(game_pk: str = GAME_PK) -> str:
    """MLB Stats API live-feed URL for a game."""
    return f"https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live"

# Pitch ``details.call.code`` values that mean the batter swung. Used to drive
# the batter-swing animation: "X" = in play, "S" = swinging strike, "F" = foul,
# "W" = swinging strike (blocked), "T" = foul tip.
# In-play calls also mean the batter swung: 'X' out(s), 'E' run(s), 'D' no out;
# 'L' foul bunt and 'M' missed bunt are swing/bunt attempts.
_SWING_CALL_CODES = {"S", "X", "F", "W", "T", "E", "D", "L", "M"}

# The 50-ft coordinate fields a pitch needs before it can be simulated. Right
# after a pitch these are present-but-None in the feed, so the trajectory
# builder checks for this exact set before trusting a pitch event.
_COORD_KEYS = ('x0', 'y0', 'z0', 'vX0', 'vY0', 'vZ0', 'aX', 'aY', 'aZ')

# The pitch is only fully simulatable once its spin block is populated too:
# the live feed publishes coordinates and spin on a lag, so a just-thrown
# pitch can have complete 50-ft coordinates while ``breaks.spinRate`` /
# ``breaks.spinDirection`` are still None. The spin reconstruction in
# statcast_to_sim_params does ``float(release_spin_rate)``, so trusting such a
# pitch makes /api/trajectory 500 ("Simulation failed: float() argument must
# be a string or a real number, not 'NoneType'") and the frontend falls back
# to replaying the previous game's last scene instead of advancing.

def _pitch_is_simulatable(pitch_event: dict) -> bool:
    """True when a pitch event has everything the simulator needs.

    Requires complete 50-ft coordinates (the fields back-propagated to the
    release point) AND a non-None spin rate/direction, matching what
    ``_pitch_parameters_from_event`` feeds to ``statcast_to_sim_params``.
    """
    pitch_data = pitch_event.get('pitchData') or {}
    coordinates = pitch_data.get('coordinates') or {}
    breaks = pitch_data.get('breaks') or {}
    return (
        all(coordinates.get(k) is not None for k in _COORD_KEYS)
        and breaks.get('spinRate') is not None
        and breaks.get('spinDirection') is not None
    )


# The live frontend polls these two endpoints once per second. Keep the latest
# response for each game/client cursor (and trajectory environment), and
# serialize builds per key so concurrent requests cannot run the same simulation
# twice.
_TRAJECTORY_CACHE: dict[tuple[str, str, str], dict] = {}
_TRAJECTORY_CACHE_GUARD = threading.RLock()
_TRAJECTORY_BUILD_LOCKS: dict[tuple[str, str, str], threading.Lock] = {}
_BATTED_BALL_CACHE: dict[tuple[str, str], dict] = {}
_BATTED_BALL_CACHE_GUARD = threading.RLock()
_BATTED_BALL_BUILD_LOCKS: dict[tuple[str, str], threading.Lock] = {}
# Cursor-specific responses are useful for a short catch-up window, but keeping
# every cursor seen during a long game would make the in-memory cache grow once
# per applied pitch/hit. Keep a bounded LRU-like window per game/environment.
_TRAJECTORY_CURSOR_CACHE_MAX_ENTRIES = 16
_BATTED_BALL_CURSOR_CACHE_MAX_ENTRIES = 16


def _prune_cursor_cache_entries(
    cache: dict,
    keep_key: tuple,
    max_cursor_entries: int,
) -> None:
    """Drop the least-recently-used cursor entries in one cache scope.

    The caller holds the cache's guard. The empty cursor is the shared initial
    response and is intentionally retained; only cursor-specific entries are
    bounded. ``keep_key`` is protected so a just-built response cannot be
    evicted before it is returned.
    """
    if max_cursor_entries < 1 or not isinstance(keep_key, tuple):
        return

    scope = keep_key[:-1]
    cursor_entries = [
        (key, entry)
        for key, entry in cache.items()
        if (
            isinstance(key, tuple)
            and len(key) == len(keep_key)
            and key[:-1] == scope
            and key[-1]
        )
    ]
    excess = len(cursor_entries) - max_cursor_entries
    if excess <= 0:
        return

    candidates = [item for item in cursor_entries if item[0] != keep_key]
    candidates.sort(
        key=lambda item: (
            item[1].get("last_used_at", 0.0),
            str(item[0]),
        )
    )
    for key, _ in candidates[:excess]:
        cache.pop(key, None)


def _cache_build_lock(lock_map: dict, guard: threading.RLock, key):
    """Return the single-flight lock for one cache key."""
    with guard:
        lock = lock_map.get(key)
        if lock is None:
            lock = threading.Lock()
            lock_map[key] = lock
        return lock


def _stable_fingerprint(value) -> str:
    """Create a deterministic fingerprint for the feed data used by a payload."""
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), default=str
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _latest_pitch_event(data: dict) -> tuple[dict, dict, int] | None:
    """Find the newest pitch event, even when its metadata is still incomplete."""
    all_plays = data.get('liveData', {}).get('plays', {}).get('allPlays') or []
    for play in reversed(all_plays):
        events = play.get('playEvents', [])
        for index in range(len(events) - 1, -1, -1):
            event = events[index]
            if event.get('isPitch'):
                return play, event, index
    return None


def _simulatable_pitch_events(data: dict) -> list[tuple[dict, dict, int]]:
    """Return simulatable pitch events in feed order for catch-up playback."""
    all_plays = data.get('liveData', {}).get('plays', {}).get('allPlays') or []
    events = []
    for play in all_plays:
        for index, event in enumerate(play.get('playEvents', [])):
            if event.get('isPitch') and _pitch_is_simulatable(event):
                events.append((play, event, index))
    return events


def _pitch_play_id(play: dict, pitch: dict) -> str:
    """Build the stable frontend identifier for one pitch event."""
    return f"AB{play.get('about', {}).get('atBatIndex')}-P{pitch.get('pitchNumber')}"


def _latest_simulatable_pitch(data: dict) -> tuple[dict, dict, int]:
    """Find the newest pitch event that has all data required by the simulator."""
    all_plays = data.get('liveData', {}).get('plays', {}).get('allPlays') or []
    if not all_plays:
        raise HTTPException(status_code=404, detail="Game hasn't started yet!")

    for play in reversed(all_plays):
        events = play.get('playEvents', [])
        for index in range(len(events) - 1, -1, -1):
            event = events[index]
            if event.get('isPitch') and _pitch_is_simulatable(event):
                return play, event, index

    raise HTTPException(status_code=404, detail="No simulated pitch data yet.")


def _pending_pitch_metadata(data: dict) -> dict:
    """Describe a newest pitch that is waiting for lagging feed metadata."""
    latest = _latest_pitch_event(data)
    if latest is None:
        return {
            "waiting_for_pitch_data": False,
            "pending_pitch_id": None,
            "pending_at_bat_index": None,
            "pending_pitch_number": None,
        }

    play, pitch, _ = latest
    if _pitch_is_simulatable(pitch):
        return {
            "waiting_for_pitch_data": False,
            "pending_pitch_id": None,
            "pending_at_bat_index": None,
            "pending_pitch_number": None,
        }

    at_bat_index = (play.get('about') or {}).get('atBatIndex')
    pitch_number = pitch.get('pitchNumber')
    return {
        "waiting_for_pitch_data": True,
        "pending_pitch_id": f"AB{at_bat_index}-P{pitch_number}",
        "pending_at_bat_index": at_bat_index,
        "pending_pitch_number": pitch_number,
    }


def _trajectory_source_key(data: dict, env: EnvironmentParameters, env_meta: dict) -> str:
    """Fingerprint the latest valid/pending pitch and environment."""
    play, pitch, pitch_index = _latest_simulatable_pitch(data)
    events = play.get('playEvents', [])
    next_event = events[pitch_index + 1] if pitch_index + 1 < len(events) else None
    latest_pitch = _latest_pitch_event(data)
    env_values = {
        name: getattr(env, name, None)
        for name in (
            'temp_F', 'elev_m', 'relative_humidity', 'pressure_mmHg',
            'vwind_mph', 'phiwind_deg', 'hwind_m',
        )
    }
    return _stable_fingerprint({
        # These are the parts of the play that can enrich/change the payload
        # after a pitch first becomes simulatable (result, hit data, runners,
        # or a wild-pitch/passed-ball action event).
        "at_bat_index": (play.get('about') or {}).get('atBatIndex'),
        "play_complete": (play.get('about') or {}).get('isComplete'),
        "matchup": play.get('matchup'),
        "result": play.get('result'),
        "runners": play.get('runners'),
        "pitch": pitch,
        "latest_pitch": latest_pitch[1] if latest_pitch else None,
        "next_event": next_event if next_event and not next_event.get('isPitch') else None,
        "environment": env_values,
        "environment_meta": env_meta,
    })


def _batted_ball_source_key(data: dict) -> str:
    """Fingerprint every hit needed by cursor-specific responses."""
    events = _batted_ball_events(data)
    return _stable_fingerprint([
        {
            "at_bat_index": (play.get('about') or {}).get('atBatIndex'),
            "play_complete": (play.get('about') or {}).get('isComplete'),
            "matchup": play.get('matchup'),
            "result": play.get('result'),
            "runners": play.get('runners'),
            "hit_event_index": hit_event_index,
            "hit_data": hit_data,
        }
        for play, hit_data, hit_event_index in events
    ])


# Baserunning miscues recorded as a play's action events (not its result). A
# wild pitch / passed ball is emitted as an action event immediately after the
# pitch it happened on, so the frontend can surface it as WILD PITCH / PASSED
# BALL instead of a bare BALL/STRIKE. Keys are the feed's ``eventType`` values.
_ACTION_EVENT_LABELS = {
    'wild_pitch': 'Wild Pitch',
    'passed_ball': 'Passed Ball',
}

# ---------------------------------------------------------------------------
# Statcast bat tracking lookup.
#
# The statsapi live feed does not carry bat tracking, so ``swing_path_tilt``
# and ``attack_angle`` are pulled best-effort from Baseball Savant's Statcast
# search CSV for the game and matched to the at-bat by batter id +
# plate-appearance + pitch number.
#
# Note: statcast_search has no ``game_pk`` filter (passing one makes it
# silently return zero rows), so rows are fetched for a small date window
# around the game's date and filtered to this game's ``game_pk`` column
# client-side.
# ---------------------------------------------------------------------------
_SAVANT_SEARCH_URL = "https://baseballsavant.mlb.com/statcast_search/csv"
_savant_rows_cache: dict[str, list[dict]] = {}


def _fetch_savant_rows(game_pk: str, game_date: str | None) -> list[dict]:
    """Fetch and cache the per-pitch Statcast search CSV rows for a game.

    Savant's ``statcast_search`` endpoint has no ``game_pk`` filter, so the
    rows are fetched for a window around the game's official date (exclusive
    bounds, widened by two days to absorb timezone drift) and filtered to this
    game's ``game_pk`` column. Returns an empty list when the date is unknown
    or on any failure, so callers fall back to a neutral swing plane without
    breaking the trajectory endpoint.
    """
    key = str(game_pk)
    if key in _savant_rows_cache:
        return _savant_rows_cache[key]
    game_day = None
    if game_date:
        try:
            game_day = datetime.strptime(game_date, '%Y-%m-%d')
        except ValueError:
            game_day = None
    if game_day is None:
        _savant_rows_cache[key] = []
        return []
    try:
        resp = requests.get(
            _SAVANT_SEARCH_URL,
            params={
                "all": "true",
                "type": "details",
                "game_date_gt": (game_day - timedelta(days=2)).strftime('%Y-%m-%d'),
                "game_date_lt": (game_day + timedelta(days=2)).strftime('%Y-%m-%d'),
                "min_pitches": 0,
                "min_results": 0,
                "group_by": "name",
                "sort_col": "pitches",
                "player_event_sort": "h_launch_speed",
                "sort_order": "desc",
                "min_abs": 0,
                "min_pas": 0,
            },
            timeout=15,
        )
        resp.raise_for_status()
        rows = [
            row for row in csv.DictReader(io.StringIO(resp.text))
            if row.get('game_pk') == key
        ]
    except Exception:
        rows = []
    # Only cache successful fetches: games Savant has not ingested yet return
    # empty, and caching that would keep the trajectory null forever even after
    # the data arrives.
    if rows:
        _savant_rows_cache[key] = rows
    return rows


def _bat_tracking_for_pitch(game_pk: str, batter_id, at_bat_index, pitch_number, game_date: str | None = None) -> dict:
    """Look up Statcast bat tracking (``swing_path_tilt``, ``attack_angle``) for a pitch.

    Savant's ``at_bat_number`` is 1-based while the statsapi ``about.atBatIndex``
    is 0-based, so the lookup uses ``at_bat_index + 1``. Each field is ``None``
    when the pitch was not swung at (Savant leaves the fields blank) or the
    lookup fails.
    """
    result = {"swing_path_tilt": None, "attack_angle": None}
    if batter_id is None or at_bat_index is None or pitch_number is None:
        return result
    target_at_bat = str(int(at_bat_index) + 1)
    for row in _fetch_savant_rows(game_pk, game_date):
        if (row.get('batter') == str(batter_id)
                and row.get('at_bat_number') == target_at_bat
                and row.get('pitch_number') == str(pitch_number)):
            for key in ("swing_path_tilt", "attack_angle"):
                raw = (row.get(key) or '').strip()
                if not raw:
                    continue
                try:
                    result[key] = float(raw)
                except ValueError:
                    pass
            return result
    return result


def _parse_height_inches(height_str) -> int | None:
    """Parse an MLB player ``height`` string (e.g. ``"6' 3\""``) into inches."""
    if not height_str:
        return None
    try:
        parts = str(height_str).replace('"', '').split("'")
        feet = int(parts[0].strip())
        inches = int(parts[1].strip()) if len(parts) > 1 and parts[1].strip() else 0
        return feet * 12 + inches
    except (TypeError, ValueError, IndexError):
        return None


def _air_density_from_env(env: EnvironmentParameters) -> float:
    """Compute the air density (kg/m^3) the simulator integrates with for ``env``.

    Mirrors ``FullBallTrajectorySimulator.simulate``'s density call so the spin
    inversion and the forward model use the same density. Used to thread the
    live game density into ``statcast_to_sim_params`` (the pfx/accel spin
    recovery), which otherwise assumes standard sea-level air and understates
    spin at altitude.
    """
    sim = FullBallTrajectorySimulator(integration_method=IntegrationMethod.RK4)
    temp_C = (5.0 / 9.0) * (env.temp_F - 32.0)
    return sim.calculate_air_density(
        temp_C, env.elev_m, env.relative_humidity, env.pressure_mmHg
    )


def _reconstructed_spin_axis(sim_params: dict) -> list | None:
    """Reconstruct the release spin vector (rad/s) in the app's world frame.

    Mirrors the initial (wx, wy, wz) spin state built inside
    ``FullBallTrajectorySimulator.simulate`` from the decomposed
    backspin/sidespin/gyro params — the physically-correct spin axis recovered
    from the 50-ft kinematics, no clock-face conventions involved. The sim's
    frame is (x, y=depth, z=height); the app's world is (x, y=height,
    z=-depth), so the vector is remapped before returning. The frontend
    normalizes this to rotate the ball model, and the drawer projects it
    (X right, Y up) for the axis arrow.
    """
    try:
        backspin = float(sim_params.get('backspin_rpm') or 0.0)
        sidespin = float(sim_params.get('sidespin_rpm') or 0.0)
        wg = float(sim_params.get('wg_rpm') or 0.0)
        v0 = float(sim_params.get('v0_mps') or 0.0)
        theta = math.radians(float(sim_params.get('theta_deg') or 0.0))
        phi = math.radians(float(sim_params.get('phi_deg') or 0.0))
        rpm_to_rad = 2.0 * math.pi / 60.0

        v0x = v0 * math.cos(theta) * math.sin(phi)
        v0y = -v0 * math.cos(theta) * math.cos(phi)
        v0z = v0 * math.sin(theta)

        wx = (-backspin * math.cos(phi) - sidespin * math.sin(theta) * math.sin(phi)
              + (wg * v0x / v0 if v0 else 0.0)) * rpm_to_rad
        wy = (backspin * math.sin(phi) - sidespin * math.sin(theta) * math.cos(phi)
              + (wg * v0y / v0 if v0 else 0.0)) * rpm_to_rad
        wz = (sidespin * math.cos(theta) + (wg * v0z / v0 if v0 else 0.0)) * rpm_to_rad

        # Sim frame (x, y=depth, z=height) -> app world (x, y=height, z=-depth)
        return [wx, wz, -wy]
    except (TypeError, ValueError):
        return None


def _pitch_parameters_from_event(play: dict, pitch_event: dict,
                                 air_density_kg_m3: float | None = None) -> dict:
    """
    Build the simulator's ``PitchParameters`` for a single pitch event from the
    MLB live-feed JSON.

    Reconstructs the release point by back-propagating the Statcast 50-ft
    measurements to the reported extension, converts to simulator inputs via
    ``statcast_to_sim_params``, and returns the parsed pitch plus the raw 50-ft
    kinematics the payload's quadratic trajectory needs.

    ``air_density_kg_m3`` (optional) is the game air density used to invert the
    observed pfx/accel into spin (both backspin and sidespin), so spin recovery
    matches the air the pitch actually flew through. When omitted,
    ``statcast_to_sim_params`` falls back to the standard sea-level density.
    """
    pitch_data = pitch_event.get('pitchData', {})
    coordinates = pitch_data.get('coordinates', {})
    breaks = pitch_data.get('breaks', {})

    x0_50 = float(coordinates.get('x0', 0.0))
    y0_50 = float(coordinates.get('y0', 50.0))
    z0_50 = float(coordinates.get('z0', 0.0))
    vx0_50 = float(coordinates.get('vX0', 0.0))
    vy0_50 = float(coordinates.get('vY0', 0.0))
    vz0_50 = float(coordinates.get('vZ0', 0.0))
    ax = float(coordinates.get('aX', 0.0))
    ay = float(coordinates.get('aY', 0.0))
    az = float(coordinates.get('aZ', 0.0))

    extension_ft = pitch_data.get('extension')
    if extension_ft is not None:
        release_ext = float(extension_ft)
    else:
        release_ext = 60.5 - y0_50

    # Backpropagate (x0, y0, z0) from y=50ft to release point y_release = 60.5 - release_ext
    y_rel = 60.5 - release_ext
    vyR_sq = max(0.0, vy0_50**2 + 2 * ay * (y_rel - y0_50))
    vyR = -math.sqrt(vyR_sq)
    tR = (vyR - vy0_50) / ay if ay != 0 else (y_rel - y0_50) / vy0_50
    x_rel = x0_50 + vx0_50 * tR + 0.5 * ax * tR**2
    z_rel = z0_50 + vz0_50 * tR + 0.5 * az * tR**2

    pitch_type_code = pitch_event.get('details', {}).get('type', {}).get('code', 'FF')

    pfx_x_in = coordinates.get('pfxX')
    pfx_z_in = coordinates.get('pfxZ')

    statcast_data = {
        "release_pos_x":   x_rel,
        "release_extension": release_ext,
        "release_pos_z":   z_rel,
        "vx0": vx0_50,
        "vy0": vy0_50,
        "vz0": vz0_50,
        "ax":  ax,
        "ay":  ay,
        "az":  az,
        "pfx_x": float(pfx_x_in) / 12.0 if pfx_x_in is not None else None,
        "pfx_z": float(pfx_z_in) / 12.0 if pfx_z_in is not None else None,
        "release_spin_rate": breaks.get('spinRate'),
        "spin_axis":         breaks.get('spinDirection'),
        "pitch_type": pitch_type_code,
        "p_throws": play.get('matchup', {}).get('pitcherHand', {}).get('code', 'R')
    }

    # Recover the full transverse spin (backspin + sidespin) with the live air
    # density when available; the horizontal (sidespin) Magnus is then scaled by
    # the density-dependent SIDESPIN_SCALE in the simulator so the sim's
    # horizontal force matches the measured 9P acceleration across venues.
    spin_kwargs = {"spin_method": "bsg", "accel_method": True}
    if air_density_kg_m3 is not None:
        spin_kwargs["rho"] = air_density_kg_m3
    sim_params = statcast_to_sim_params(statcast_data, **spin_kwargs)

    valid_keys = ['x0', 'y0', 'z0', 'v0_mps', 'theta_deg', 'phi_deg',
                  'backspin_rpm', 'sidespin_rpm', 'wg_rpm', 'batter_hand']
    pitch_kwargs = {k: v for k, v in sim_params.items() if k in valid_keys}
    if 'batter_hand' not in pitch_kwargs:
        pitch_kwargs['batter_hand'] = play.get('matchup', {}).get('batterHand', {}).get('code', 'R')

    pitch = PitchParameters(**pitch_kwargs)

    return {
        "pitch": pitch,
        "sim_params": sim_params,
        "x0_50": x0_50, "y0_50": y0_50, "z0_50": z0_50,
        "vx0_50": vx0_50, "vy0_50": vy0_50, "vz0_50": vz0_50,
        "ax": ax, "ay": ay, "az": az,
        "tR": tR,
    }


def _build_trajectory_payload(data: dict, env: EnvironmentParameters, env_meta: dict, game_pk: str = GAME_PK) -> dict:
    """
    Internal helper: given the raw MLB live-feed JSON and resolved environment
    params, run the physics simulation and return the full payload dict.
    Extracted so both /api/trajectory and /api/trajectory/compare can share it.
    """
    last_play, last_pitch, last_pitch_index = _latest_simulatable_pitch(data)
    return _build_pitch_payload(data, last_play, last_pitch, last_pitch_index, env, env_meta, game_pk)


def _build_pitch_payload(data: dict, play: dict, pitch_event: dict, pitch_index: Optional[int],
                         env: EnvironmentParameters, env_meta: dict, game_pk: str = GAME_PK) -> dict:
    """
    Build the full trajectory payload for one specific pitch event. Shared by
    /api/trajectory (latest pitch) and /api/at-bat (every pitch of an at-bat,
    so the frontend can replay any of them).
    """
    parsed = _pitch_parameters_from_event(
        play, pitch_event, air_density_kg_m3=_air_density_from_env(env)
    )
    pitch = parsed["pitch"]
    sim_params = parsed["sim_params"]

    pitch_data = pitch_event.get('pitchData', {})
    coordinates = pitch_data.get('coordinates', {})
    breaks = pitch_data.get('breaks', {})

    pitcher_id = play.get('matchup', {}).get('pitcher', {}).get('id')
    pitch_type_code = pitch_event.get('details', {}).get('type', {}).get('code', 'FF')
    pitch_type_description = (pitch_event.get('details', {}).get('type') or {}).get('description')

    sim = FullBallTrajectorySimulator(integration_method=IntegrationMethod.RK4)
    sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)

    # True spin axis in world space (rad/s), for the ball model's rotation and
    # the drawer's spin-axis arrow.
    spin_axis = _reconstructed_spin_axis(sim_params)

    matchup = play.get('matchup', {})
    pitcher = matchup.get('pitcher', {}).get('fullName', 'N/A')
    batter = matchup.get('batter', {}).get('fullName', 'N/A')
    bat_side = matchup.get('batSide', {}).get('code', 'R')
    # The pitcher's throwing hand (R/L), for the pitcher model's animation
    # (RightHandPitch/LeftHandPitch) and glove-hand setup.
    pitch_hand = matchup.get('pitchHand', {}).get('code', 'R')
    call_code = pitch_event.get('details', {}).get('call', {}).get('code')
    swing = call_code in _SWING_CALL_CODES
    # Whether the bat actually met the ball (in play or foul), as opposed to a
    # swing-and-miss. Drives the batted-ball handoff: a whiff keeps flying
    # through the strike zone instead of spawning a batted ball. In-play calls
    # are 'X' (out(s)), 'E' (run(s)), and 'D' (no out); 'F' foul and 'L' foul
    # bunt are contact that stays on the foul side. A foul tip ('T') is a whiff.
    is_contact = call_code in ('X', 'E', 'D', 'F', 'L')
    # The resolved play result (e.g. Strikeout, Walk, Flyout) so the frontend
    # can show a specific outcome instead of a generic BALL/STRIKE/OUT.
    result = play.get('result') or {}
    result_event = result.get('event')
    # If the latest pitch got away from the catcher, the feed records that as
    # an action event right after the pitch event (the pitch's own details only
    # carry the ball/strike call). Surface it so the frontend can show WILD
    # PITCH / PASSED BALL when that pitch is the one being animated.
    action_event = None
    if pitch_index is not None:
        events = play.get('playEvents', [])
        if pitch_index + 1 < len(events):
            nxt = events[pitch_index + 1]
            details = nxt.get('details') or {}
            if not nxt.get('isPitch'):
                et = details.get('eventType')
                if et in _ACTION_EVENT_LABELS:
                    action_event = details.get('event') or _ACTION_EVENT_LABELS[et]
    game_date = data.get('gameData', {}).get('datetime', {}).get('officialDate', 'Unknown Date')
    # Top of the inning: the home team bats, so the away team fields (the
    # pitcher wears the away uniform).
    is_top_inning = bool(data.get('liveData', {}).get('linescore', {}).get('isTopInning'))
    bat_tracking = _bat_tracking_for_pitch(
        game_pk,
        matchup.get('batter', {}).get('id'),
        play.get('about', {}).get('atBatIndex'),
        pitch_event.get('pitchNumber'),
        game_date,
    )

    # Expected batting average (xBA) for this pitch, computed locally from the
    # batted ball's exit velocity + launch angle (and the batter's sprint speed
    # on ground balls). None when the pitch didn't produce a batted ball so the
    # pitch panel shows a dash.
    hit_data = pitch_event.get('hitData') or {}
    xba = _compute_xba(
        hit_data.get('launchSpeed'),
        hit_data.get('launchAngle'),
        _sprint_speed_for_batter(matchup.get('batter', {}).get('id')),
    )
    # Keep the hit attached to the pitch response as well as the separate
    # /api/batted-ball response. The two endpoints are polled independently;
    # without this copy a contact pitch can reach the frontend first, then wait
    # on a race with the hit endpoint and either launch late or pick up a stale
    # hit from the previous play.
    batted_ball = None
    if pitch_event.get('hitData'):
        batted_ball = _build_hit_payload(
            play, pitch_event['hitData'], pitch_index or 0, data,
        )

    # Stable identifier for this pitch, so the frontend can tell when polling
    # returns a genuinely new play (and skip re-animating the same one).
    play_id = f"AB{play.get('about', {}).get('atBatIndex')}-P{pitch_event.get('pitchNumber')}"

    batter_id = matchup.get('batter', {}).get('id')
    batter_height = None
    if batter_id is not None:
        player = data.get('gameData', {}).get('players', {}).get(f"ID{batter_id}", {})
        batter_height = _parse_height_inches(player.get('height'))

    start_speed = pitch_data.get('startSpeed', 0)
    all_plays = data['liveData']['plays']['allPlays']
    total_pitches = sum(
        1 for pl in all_plays
        if pl.get('matchup', {}).get('pitcher', {}).get('id') == pitcher_id
        for event in pl.get('playEvents', []) if event.get('isPitch')
    )

    sz_top, sz_bottom = 3.5, 1.5
    for event in play.get('playEvents', []):
        if 'pitchData' in event:
            pd = event['pitchData']
            if 'strikeZoneTop' in pd:
                sz_top = pd['strikeZoneTop']
            if 'strikeZoneBottom' in pd:
                sz_bottom = pd['strikeZoneBottom']

    statcast_px = coordinates.get('pX')
    statcast_pz = coordinates.get('pZ')

    strike_zone_depth_in = pitch_data.get('strikeZoneDepth', 8.5)
    mid_plate_y = (17.0 - strike_zone_depth_in) / 12.0

    # 50-ft kinematics from the parsed pitch (shared with _pitch_parameters_from_event)
    x0_50 = parsed["x0_50"]
    y0_50 = parsed["y0_50"]
    z0_50 = parsed["z0_50"]
    vx0_50 = parsed["vx0_50"]
    vy0_50 = parsed["vy0_50"]
    vz0_50 = parsed["vz0_50"]
    ax = parsed["ax"]
    ay = parsed["ay"]
    az = parsed["az"]
    tR = parsed["tR"]

    a_coeff = 0.5 * ay
    b_coeff = vy0_50
    c_coeff = y0_50 - mid_plate_y
    discriminant = b_coeff**2 - 4 * a_coeff * c_coeff
    if discriminant >= 0 and a_coeff != 0:
        t_mid   = (-b_coeff - math.sqrt(discriminant)) / (2 * a_coeff)
        px_mid  = x0_50 + vx0_50 * t_mid + 0.5 * ax * t_mid**2
        pz_mid  = z0_50 + vz0_50 * t_mid + 0.5 * az * t_mid**2
    else:
        px_mid = statcast_px
        pz_mid = statcast_pz

    quadratic_trajectory = []
    t_curr = tR
    dt = 0.005
    while True:
        x_q = x0_50 + vx0_50 * t_curr + 0.5 * ax * t_curr**2
        y_q = y0_50 + vy0_50 * t_curr + 0.5 * ay * t_curr**2
        z_q = z0_50 + vz0_50 * t_curr + 0.5 * az * t_curr**2
        quadratic_trajectory.append({"x": x_q * 0.3048, "y": y_q * 0.3048, "z": z_q * 0.3048, "t": t_curr - tR})
        if y_q <= 0.0 or (t_curr - tR) > 1.0:
            break
        t_curr += dt

    return {
        "success": True,
        "play_id": play_id,
        "at_bat_index": play.get('about', {}).get('atBatIndex'),
        "play_complete": bool((play.get('about') or {}).get('isComplete')),
        "pitcher": pitcher,
        "batter": batter,
        "bat_side": bat_side,
        "pitch_hand": pitch_hand,
        "is_top_inning": is_top_inning,
        "swing": swing,
        "call_code": call_code,
        "is_contact": is_contact,
        "result_event": result_event,
        "action_event": action_event,
        "swing_path_tilt": bat_tracking["swing_path_tilt"],
        "attack_angle": bat_tracking["attack_angle"],
        "batter_height": batter_height,
        "pitch_type": pitch_type_code,
        "pitch_type_description": pitch_type_description,
        "speed_mph": start_speed,
        # True spin axis (rad/s, world frame) + total spin rate (rpm), so the
        # frontend can spin the ball model on the physically-correct axis.
        "spin_axis": spin_axis,
        "spin_direction": breaks.get('spinDirection'),
        "spin_rate": breaks.get('spinRate'),
        "game_date": game_date,
        "total_pitches": total_pitches,
        "strike_zone_top": sz_top,
        "strike_zone_bottom": sz_bottom,
        "statcast_px": statcast_px,
        "statcast_pz": statcast_pz,
        "statcast_px_mid": px_mid,
        "statcast_pz_mid": pz_mid,
        # Statcast induced break (inches, raw pfxX/pfxZ) for the pitch panel's
        # H/V Break rows.
        "pfx_x": float(coordinates['pfxX']) if coordinates.get('pfxX') is not None else None,
        "pfx_z": float(coordinates['pfxZ']) if coordinates.get('pfxZ') is not None else None,
        "xba": xba,
        "batted_ball": batted_ball,
        "spin_efficiency":  sim_params.get('spin_efficiency'),
        "active_spin_rpm": math.sqrt(
            sim_params.get('backspin_rpm', 0.0) ** 2 +
            sim_params.get('sidespin_rpm', 0.0) ** 2
        ),
        "sim_params": sim_params,
        "environment": env_meta,
        # Snapshot the score/count at this pitch so queued animations can
        # commit scoreboard changes in order instead of reading the feed's
        # already-advanced latest state.
        "game_state": _game_state_snapshot(data, play, pitch_event, pitch_index),
        "trajectory": sim.trajectory,
        "quadratic_trajectory": quadratic_trajectory,
    }


@app.get("/api/trajectory")
def get_trajectory(env: str = "live", game_pk: str = GAME_PK,
                   after_play_id: Optional[str] = None):
    """Return a single trajectory simulation.

    Query params
    ------------
    env : "live" (default) | "default"
        "live"    – venue elevation-derived pressure + sky-condition humidity,
                    plus game temperature from the MLB Stats API game feed.
        "default" – use neutral baseline conditions (70 °F, 15 ft elev, 50 % RH).
    after_play_id : optional stable pitch id
        Last trajectory play the client has applied. When supplied, any valid
        pitches after this cursor are returned in ``queued_trajectories`` even
        if an earlier response was lost.

    The live path deliberately skips the Open-Meteo archive call (observed=False):
    the A/B sweep (backend/test_weather_accuracy_multi.py) shows the observed
    surface-pressure/RH refinement moves the plate crossing by <=0.01 in vs the
    elevation-derived estimate, while venue elevation + game temp — both free
    from the feed — capture essentially all of the live-vs-default accuracy gain.
    """
    print(f"LOADING LEVEL... Polling game {game_pk} (env={env})")
    response = requests.get(_feed_url(game_pk))
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch from MLB API")
    data = response.json()
    try:
        if env == "default":
            resolved_env, env_meta = DEFAULT_ENV, DEFAULT_ENV_META
        else:
            resolved_env, env_meta = fetch_environment_params(data.get('gameData', {}), observed=False)

        cache_env = "default" if env == "default" else "live"
        # The queued response depends on the client's applied cursor. Keep
        # cursor-specific cache entries so one client cannot receive another
        # client's catch-up list, and so advancing the cursor immediately
        # narrows the next response to only still-unapplied pitches.
        cache_key = (str(game_pk), cache_env, str(after_play_id or ""))
        source_key = _trajectory_source_key(data, resolved_env, env_meta)
        build_lock = _cache_build_lock(
            _TRAJECTORY_BUILD_LOCKS, _TRAJECTORY_CACHE_GUARD, cache_key
        )
        with build_lock:
            with _TRAJECTORY_CACHE_GUARD:
                cached = _TRAJECTORY_CACHE.get(cache_key)
                if cached and cached["source_key"] == source_key:
                    cached["last_used_at"] = time.monotonic()
                    _prune_cursor_cache_entries(
                        _TRAJECTORY_CACHE,
                        cache_key,
                        _TRAJECTORY_CURSOR_CACHE_MAX_ENTRIES,
                    )
            if cached and cached["source_key"] == source_key:
                print(f"TRAJECTORY CACHE HIT... game {game_pk} (env={cache_env})")
                return cached["response"]

            # If the feed advanced by more than one valid pitch since the last
            # build, include the intervening payloads so the frontend can
            # animate every pitch instead of jumping straight to the newest.
            queued_trajectories = []
            previous_play_id = after_play_id or (cached or {}).get("response", {}).get("play_id")
            latest_play_id = None
            simulatable = _simulatable_pitch_events(data)
            if simulatable:
                latest_play_id = _pitch_play_id(simulatable[-1][0], simulatable[-1][1])
            if previous_play_id and latest_play_id and previous_play_id != latest_play_id:
                previous_index = next(
                    (
                        index for index, (play, pitch, _) in enumerate(simulatable)
                        if _pitch_play_id(play, pitch) == previous_play_id
                    ),
                    None,
                )
                if previous_index is not None:
                    for play, pitch, pitch_index in simulatable[previous_index + 1:]:
                        if _pitch_play_id(play, pitch) == latest_play_id:
                            break
                        try:
                            queued_trajectories.append(
                                _build_pitch_payload(
                                    data, play, pitch, pitch_index,
                                    resolved_env, env_meta, game_pk,
                                )
                            )
                        except Exception:
                            # A catch-up payload is best-effort; never let one
                            # malformed historical event hide the newest valid
                            # pitch from the live endpoint.
                            continue

            payload = _build_trajectory_payload(
                data, resolved_env, env_meta, game_pk
            )
            payload.update(_pending_pitch_metadata(data))
            payload["queued_trajectories"] = queued_trajectories
            with _TRAJECTORY_CACHE_GUARD:
                _TRAJECTORY_CACHE[cache_key] = {
                    "source_key": source_key,
                    "response": payload,
                    "last_used_at": time.monotonic(),
                }
                _prune_cursor_cache_entries(
                    _TRAJECTORY_CACHE,
                    cache_key,
                    _TRAJECTORY_CURSOR_CACHE_MAX_ENTRIES,
                )
            return payload
    except HTTPException:
        raise
    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Simulation failed: {e}")


@app.get("/api/trajectory/compare")
def get_trajectory_compare(game_pk: str = GAME_PK):
    """Return both live-weather and default-environment trajectories in one
    response so the frontend can overlay them for visual comparison.

    Response keys
    -------------
    live    – trajectory simulated with venue weather/elevation (elevation-derived
              pressure + sky-condition humidity, no Open-Meteo call).
    default – trajectory simulated with neutral MLB baseline conditions.
    """
    print(f"COMPARE MODE... Polling game {game_pk}")
    response = requests.get(_feed_url(game_pk))
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch from MLB API")
    data = response.json()
    try:
        # No Open-Meteo call (observed=False): see get_trajectory docstring.
        live_env, live_meta   = fetch_environment_params(data.get('gameData', {}), observed=False)
        live_payload    = _build_trajectory_payload(data, live_env, live_meta, game_pk)
        default_payload = _build_trajectory_payload(data, DEFAULT_ENV, DEFAULT_ENV_META, game_pk)
        return {
            "success": True,
            "live":    live_payload,
            "default": default_payload,
        }
    except HTTPException:
        raise
    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Simulation failed: {e}")


# ---------------------------------------------------------------------------
# Battled-ball (Statcast hit) endpoint
# ---------------------------------------------------------------------------

# Statcast ``hitData.location`` codes (1-9) -> fielder position codes used by
# the frontend's ``FIELD.DEFENSE`` lookup. Multi-digit zones (e.g. "89" for
# right-center) collapse to their first digit; anything unknown defaults to CF.
_HIT_LOCATION_TO_FIELDER = {
    "1": "P",
    "2": "C",
    "3": "1B",
    "4": "2B",
    "5": "3B",
    "6": "SS",
    "7": "LF",
    "8": "CF",
    "9": "RF",
}


# MLB result ``event`` values that mean the ball was caught in the air (an out
# made by catching a fly ball). Mirrors solomon-gumball's customPlayInfo.wasCaught
# check; a Sac Fly is included because it is still a caught fly ball.
_CAUGHT_IN_AIR_EVENTS = {"Flyout", "Pop Out", "Lineout", "Sac Fly"}

# Result ``event`` values that do NOT count as an at-bat (plate appearances
# that end in a walk, hit-by-pitch, sacrifice, or catcher's interference).
_NON_AT_BAT_EVENTS = {
    "Walk", "Intent Walk", "Hit By Pitch", "Sac Fly", "Sac Bunt",
    "Catcher Interference",
}

# Result ``event`` values that are base hits (each counts one hit).
_HIT_EVENTS = {"Single", "Double", "Triple", "Home Run"}

# Result ``event`` values that retire the batter (used to count the outs a
# play recorded for the at-bat tunneling color coding).
_BATTER_OUT_EVENTS = {
    "Strikeout", "Flyout", "Pop Out", "Lineout", "Groundout", "Forceout",
    "Double Play", "Triple Play", "Grounded Into DP", "Sac Fly", "Sac Bunt",
    "Bunt Groundout",
}


def _batted_ball_events(data: dict) -> list[tuple[dict, dict, int]]:
    """Return all Statcast hit events in chronological feed order."""
    all_plays = data.get('liveData', {}).get('plays', {}).get('allPlays') or []
    return [
        (play, event['hitData'], index)
        for play in all_plays
        for index, event in enumerate(play.get('playEvents', []))
        if event.get('hitData')
    ]


def _batted_ball_play_id(play: dict, hit_event_index: int) -> str:
    """Build the stable identifier used as the batted-ball cursor."""
    return f"AB{play.get('about', {}).get('atBatIndex')}-EV{hit_event_index}"


def _latest_batted_ball(data: dict) -> tuple[dict, dict, int]:
    """Find the newest play event carrying Statcast hit data."""
    if not data.get('liveData', {}).get('plays', {}).get('allPlays'):
        raise HTTPException(status_code=404, detail="Game hasn't started yet!")

    events = _batted_ball_events(data)
    if events:
        return events[-1]
    raise HTTPException(status_code=404, detail="No batted-ball events yet.")


def _spray_angle_from_coords(coord_x, coord_y) -> float | None:
    """Compute the Statcast batted-ball spray angle from hc_x/hc_y coordinates.

    Mirrors ``computeSprayAngle`` in solomon-gumball's MathUtil (the reference
    implementation the frontend ports): ``atan((hc_x - 125) / (199 - hc_y))``
    in degrees, scaled by 0.75 and rounded to 0.1 deg. Positive values spray
    toward the batter's pull side.
    """
    if coord_x is None or coord_y is None:
        return None
    try:
        hc_x = float(coord_x)
        hc_y = float(coord_y)
    except (TypeError, ValueError):
        return None

    denominator = 199.0 - hc_y
    if abs(denominator) < 1e-9:
        return 90.0 if hc_x >= 125.0 else -90.0

    angle = math.degrees(math.atan((hc_x - 125.0) / denominator)) * 0.75
    return round(angle * 10.0) / 10.0


def _build_hit_payload(batted_play: dict, hit_data: dict, hit_event_index: int, data: dict) -> dict:
    """
    Build the batted-ball payload for one specific hit event. Shared by
    /api/batted-ball (latest hit) and /api/at-bat (replay an in-play pitch).
    """
    coordinates = hit_data.get('coordinates') or {}
    spray_angle = _spray_angle_from_coords(
        coordinates.get('coordX'), coordinates.get('coordY')
    )

    location = str(hit_data.get('location') or '8')
    fielder = _HIT_LOCATION_TO_FIELDER.get(location[:1], 'CF')

    result = batted_play.get('result', {})
    matchup = batted_play.get('matchup', {})
    play_complete = bool((batted_play.get('about') or {}).get('isComplete'))
    play_events = batted_play.get('playEvents') or []
    hit_event = play_events[hit_event_index] if hit_event_index < len(play_events) else {}
    pitch_number = hit_event.get('pitchNumber')
    at_bat_index = (batted_play.get('about') or {}).get('atBatIndex')
    pitch_play_id = (
        f"AB{at_bat_index}-P{pitch_number}"
        if pitch_number is not None else None
    )

    # A ball is "caught in the air" when the result event is an out made by
    # catching a fly ball (mirrors solomon-gumball's customPlayInfo.wasCaught
    # check on Pop Out / Flyout / Lineout, plus Sac Fly). Ground balls that
    # end in an out are NOT caught in the air — the fielder fields the ball
    # and throws/forces it, which the frontend choreographs differently.
    was_caught = result.get('event') in _CAUGHT_IN_AIR_EVENTS

    # Runner movement + defensive credits for the play, so the frontend can
    # port solomon-gumball's force-out / double-play choreography: fielders
    # with f_putout credits run to the out base while the ball is in flight,
    # and the assist chain (f_assist / f_putout / f_fielded_ball) drives the
    # throws between fielders.
    runners = []
    for run in batted_play.get('runners', []):
        mv = run.get('movement', {})
        runners.append({
            "start": mv.get('start'),
            "end": mv.get('end'),
            "outBase": mv.get('outBase'),
            "isOut": bool(mv.get('isOut')),
            "outNumber": mv.get('outNumber'),
            "credits": [
                {
                    "position": (c.get('position') or {}).get('abbreviation'),
                    "credit": c.get('credit'),
                }
                for c in run.get('credits', [])
            ],
        })
    total_outs = sum(1 for r in runners if r['isOut'])

    return {
        "success": True,
        "play_id": _batted_ball_play_id(batted_play, hit_event_index),
        "pitch_play_id": pitch_play_id,
        "pitch_number": pitch_number,
        "at_bat_index": at_bat_index,
        "play_complete": play_complete,
        "batter": matchup.get('batter', {}).get('fullName', 'N/A'),
        "pitcher": matchup.get('pitcher', {}).get('fullName', 'N/A'),
        "description": result.get('description', ''),
        "event": result.get('event'),
        "event_type": result.get('eventType'),
        "launch_speed": hit_data.get('launchSpeed'),
        "launch_angle": hit_data.get('launchAngle'),
        # xBA computed locally from EV/LA (and sprint speed on ground balls).
        "xba": _compute_xba(
            hit_data.get('launchSpeed'),
            hit_data.get('launchAngle'),
            _sprint_speed_for_batter((matchup.get('batter') or {}).get('id')),
        ),
        "spray_angle": spray_angle,
        "total_distance": hit_data.get('totalDistance'),
        "coord_x": coordinates.get('coordX'),
        "coord_y": coordinates.get('coordY'),
        "trajectory": hit_data.get('trajectory'),
        "hardness": hit_data.get('hardness'),
        "fielder": fielder,
        "was_caught": was_caught,
        "runners": runners,
        "total_outs": total_outs,
        "game_date": data.get('gameData', {}).get('datetime', {}).get('officialDate', 'Unknown Date'),
    }


@app.get("/api/batted-ball")
def get_batted_ball(game_pk: str = GAME_PK,
                    after_play_id: Optional[str] = None):
    """Return the newest hit and any hits after the client's cursor.

    ``after_play_id`` is the last batted-ball payload the client applied. The
    newest hit remains the top-level response for compatibility, while any
    intervening hits are returned in ``queued_batted_balls`` so a dropped poll
    cannot make an in-play animation disappear.
    """
    print(f"BATTED BALL... Polling game {game_pk}")
    response = requests.get(_feed_url(game_pk))
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch from MLB API")
    data = response.json()
    try:
        all_plays = data['liveData']['plays']['allPlays']
        if not all_plays:
            raise HTTPException(status_code=404, detail="Game hasn't started yet!")

        hit_events = _batted_ball_events(data)
        if not hit_events:
            raise HTTPException(status_code=404, detail="No batted-ball events yet.")
        batted_play, hit_data, hit_event_index = hit_events[-1]
        source_key = _batted_ball_source_key(data)
        cache_key = (str(game_pk), str(after_play_id or ""))
        build_lock = _cache_build_lock(
            _BATTED_BALL_BUILD_LOCKS, _BATTED_BALL_CACHE_GUARD, cache_key
        )
        with build_lock:
            with _BATTED_BALL_CACHE_GUARD:
                cached = _BATTED_BALL_CACHE.get(cache_key)
                if cached and cached["source_key"] == source_key:
                    cached["last_used_at"] = time.monotonic()
                    _prune_cursor_cache_entries(
                        _BATTED_BALL_CACHE,
                        cache_key,
                        _BATTED_BALL_CURSOR_CACHE_MAX_ENTRIES,
                    )
            if cached and cached["source_key"] == source_key:
                print(f"BATTED BALL CACHE HIT... game {game_pk}")
                return cached["response"]

            queued_batted_balls = []
            if after_play_id:
                cursor_index = next(
                    (
                        index for index, (play, _, event_index) in enumerate(hit_events)
                        if _batted_ball_play_id(play, event_index) == after_play_id
                    ),
                    None,
                )
                # If the cursor is no longer present in the feed, returning all
                # older hits is safer than silently losing the catch-up window;
                # the frontend still deduplicates any payload it has retained.
                start_index = cursor_index + 1 if cursor_index is not None else 0
                for play, hit, event_index in hit_events[start_index:-1]:
                    try:
                        queued_batted_balls.append(
                            _build_hit_payload(play, hit, event_index, data)
                        )
                    except Exception:
                        # One malformed historical hit must not hide the newest
                        # valid hit from the polling endpoint.
                        continue

            payload = _build_hit_payload(
                batted_play, hit_data, hit_event_index, data
            )
            payload["queued_batted_balls"] = queued_batted_balls
            with _BATTED_BALL_CACHE_GUARD:
                _BATTED_BALL_CACHE[cache_key] = {
                    "source_key": source_key,
                    "response": payload,
                    "last_used_at": time.monotonic(),
                }
                _prune_cursor_cache_entries(
                    _BATTED_BALL_CACHE,
                    cache_key,
                    _BATTED_BALL_CURSOR_CACHE_MAX_ENTRIES,
                )
            return payload
    except HTTPException:
        raise
    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Batted-ball parsing failed: {e}")


def _find_play_by_at_bat(all_plays: list, at_bat_index: int):
    """Return the play whose ``about.atBatIndex`` matches the target."""
    for play in all_plays:
        if (play.get('about') or {}).get('atBatIndex') == at_bat_index:
            return play
    return None


def _classify_pitch_outcome(pitch_event: dict, play: dict) -> tuple:
    """
    Classify a pitch into the at-bat tunneling buckets and count the outs its
    play recorded. Returns (outcome, outs, call_code, result_event).
    """
    call_code = pitch_event.get('details', {}).get('call', {}).get('code')
    result_event = (play.get('result') or {}).get('event')

    batter_out = result_event in _BATTER_OUT_EVENTS
    runner_outs = sum(
        1 for r in play.get('runners', [])
        if (r.get('movement') or {}).get('isOut')
    )
    outs = (1 if batter_out else 0) + runner_outs

    if call_code in ('B', '*B', 'P', 'H'):
        outcome = 'ball'
    elif call_code in ('C', 'S', 'W', 'M'):
        outcome = 'strike'
    elif call_code in ('F', 'T', 'L'):
        outcome = 'foul'
    elif call_code in ('X', 'E', 'D'):
        outcome = 'in_play_outs' if outs > 0 else 'in_play'
    else:
        outcome = 'other'

    return outcome, outs, call_code, result_event


@app.get("/api/at-bat")
def get_at_bat(at_bat_index: Optional[int] = None, game_pk: str = GAME_PK):
    """
    Return every pitch thrown in one at-bat, with its strike-zone location,
    tunneling color classification, and (for replayable pitches) the full
    trajectory + batted-ball payloads so the frontend can replay any of them.
    """
    print(f"AT-BAT... Polling game {game_pk} (at_bat_index={at_bat_index})")
    response = requests.get(_feed_url(game_pk))
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch from MLB API")
    data = response.json()
    try:
        all_plays = data['liveData']['plays']['allPlays']
        if not all_plays:
            raise HTTPException(status_code=404, detail="Game hasn't started yet!")

        # Default to the at-bat of the newest play that contains a pitch, so the
        # panel opens on the at-bat currently being shown.
        if at_bat_index is None:
            for play in reversed(all_plays):
                if any(event.get('isPitch') for event in play.get('playEvents', [])):
                    at_bat_index = (play.get('about') or {}).get('atBatIndex')
                    break
        if at_bat_index is None:
            raise HTTPException(status_code=404, detail="No at-bat available yet.")

        play = _find_play_by_at_bat(all_plays, at_bat_index)
        if play is None:
            raise HTTPException(status_code=404, detail=f"At-bat {at_bat_index} not found.")

        resolved_env, env_meta = fetch_environment_params(data.get('gameData', {}), observed=False)

        # Strike zone from this at-bat's pitch data (falls back to a league zone).
        sz_top, sz_bottom = 3.5, 1.5
        for event in play.get('playEvents', []):
            pd = event.get('pitchData')
            if not pd:
                continue
            if pd.get('strikeZoneTop') is not None:
                sz_top = pd['strikeZoneTop']
            if pd.get('strikeZoneBottom') is not None:
                sz_bottom = pd['strikeZoneBottom']

        # The one batted-ball event for an in-play at-bat (if any). ``hit_data``
        # is the event's ``hitData`` payload (launch speed/angle, coords), NOT
        # the wrapper event — _build_hit_payload expects the payload itself.
        hit_data = None
        hit_event_index = None
        for idx, event in enumerate(play.get('playEvents', [])):
            if event.get('hitData'):
                hit_data = event['hitData']
                hit_event_index = idx
                break

        # The last pitch of a completed at-bat is the one that produced the
        # play's final result (strikeout / walk / hit-by-pitch), so replaying
        # any earlier pitch must not surface that final result immediately.
        final_pitch_number = max(
            (event.get('pitchNumber') for event in play.get('playEvents', [])
             if event.get('isPitch') and event.get('pitchNumber') is not None),
            default=None,
        )

        pitches = []
        for idx, event in enumerate(play.get('playEvents', [])):
            if not event.get('isPitch'):
                continue
            pitch_number = event.get('pitchNumber')
            coords = (event.get('pitchData') or {}).get('coordinates') or {}
            replayable = _pitch_is_simulatable(event)
            outcome, outs, call_code, result_event = _classify_pitch_outcome(event, play)

            pitch_payload = None
            if replayable:
                try:
                    pitch_payload = _build_pitch_payload(
                        data, play, event, idx, resolved_env, env_meta, game_pk
                    )
                except Exception:
                    pitch_payload = None
                    replayable = False

            hit_payload = None
            if (hit_data is not None and pitch_payload is not None
                    and pitch_payload.get('is_contact')):
                try:
                    hit_payload = _build_hit_payload(play, hit_data, hit_event_index, data)
                except Exception:
                    hit_payload = None

            is_final_pitch = final_pitch_number is not None and pitch_number == final_pitch_number
            if pitch_payload is not None:
                pitch_payload['is_at_bat_final'] = is_final_pitch

            pitches.append({
                "pitch_number": pitch_number,
                "play_id": (pitch_payload.get('play_id') if pitch_payload
                            else f"AB{at_bat_index}-P{pitch_number}"),
                "call_code": call_code,
                "result_event": result_event,
                "description": (event.get('details') or {}).get('description'),
                "is_contact": (pitch_payload.get('is_contact') if pitch_payload
                               else call_code in ('X', 'E', 'D', 'F', 'L')),
                "outcome": outcome,
                "outs": outs,
                "is_at_bat_final": is_final_pitch,
                "statcast_px": coords.get('pX'),
                "statcast_pz": coords.get('pZ'),
                "statcast_px_mid": (pitch_payload.get('statcast_px_mid') if pitch_payload else None),
                "statcast_pz_mid": (pitch_payload.get('statcast_pz_mid') if pitch_payload else None),
                "replayable": replayable,
                "pitch": pitch_payload,
                "hit": hit_payload,
            })

        matchup = play.get('matchup', {})
        return {
            "success": True,
            "at_bat_index": at_bat_index,
            "batter": matchup.get('batter', {}).get('fullName', 'N/A'),
            "pitcher": matchup.get('pitcher', {}).get('fullName', 'N/A'),
            "strike_zone_top": sz_top,
            "strike_zone_bottom": sz_bottom,
            "pitches": pitches,
        }
    except HTTPException:
        raise
    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"At-bat parsing failed: {e}")


def _occupied_bases(all_plays: list) -> list:
    """Return the bases currently occupied ('1B'/'2B'/'3B'), sorted.

    The feed's ``runners`` list only includes runners who moved, scored, or were
    put out during a play, so stationary runners must be carried forward. This
    replays the runner movements of the current half-inning from its start.

    Two feed quirks make naive base accounting wrong: a runner can appear twice
    in one play (e.g. a wild pitch then a sacrifice fly), and the runners are
    listed in feed order, so a batter reaching first can be listed before the
    runner who vacated first. Each runner's legs are therefore collapsed into a
    single departure/arrival, and all departures are applied before arrivals.
    """
    if not all_plays:
        return []
    last_about = all_plays[-1].get('about') or {}
    inning = last_about.get('inning')
    half = last_about.get('halfInning')
    bases = set()
    for play in all_plays:
        about = play.get('about') or {}
        if about.get('inning') != inning or about.get('halfInning') != half:
            continue
        first_start_by_runner = {}
        last_leg_by_runner = {}
        anon = 0
        for runner in play.get('runners') or []:
            mv = runner.get('movement') or {}
            rid = ((runner.get('details') or {}).get('runner') or {}).get('id')
            if rid is None:
                rid = ('anon', anon)
                anon += 1
            if rid not in first_start_by_runner:
                first_start_by_runner[rid] = mv.get('start')
            last_leg_by_runner[rid] = (mv.get('end'), bool(mv.get('isOut')))
        departures = set()
        arrivals = set()
        for rid, first_start in first_start_by_runner.items():
            if first_start in ('1B', '2B', '3B'):
                departures.add(first_start)
            end, is_out = last_leg_by_runner[rid]
            if not is_out and end in ('1B', '2B', '3B'):
                arrivals.add(end)
        bases -= departures
        bases |= arrivals
    return sorted(bases)


def _current_count(all_plays: list) -> tuple:
    """Derive the current ball/strike count by replaying the play log.

    Each pitch event carries the count *after* that pitch, so the latest pitch
    in the latest at-bat is authoritative while that at-bat is still in
    progress. Once the at-bat ends (walk / strikeout / out / hit), the balls
    and strikes reset to 0-0 for the next batter. Used as a fallback when the
    feed's ``currentPlay.count`` is absent, so the scorebug never depends on
    the lag-prone ``linescore`` for the count.
    """
    if not all_plays:
        return (None, None)
    for play in reversed(all_plays):
        for event in reversed(play.get('playEvents', [])):
            if event.get('isPitch'):
                if (play.get('about') or {}).get('isComplete'):
                    return (0, 0)
                count = event.get('count') or {}
                return (count.get('balls'), count.get('strikes'))
    return (None, None)


def _prefix_through_pitch(data: dict, target_play: dict, pitch_index: Optional[int]) -> list:
    """Return feed plays through one pitch, hiding later events in its play."""
    all_plays = data.get('liveData', {}).get('plays', {}).get('allPlays') or []
    prefix = []
    for play in all_plays:
        if play is not target_play:
            prefix.append(play)
            continue

        if pitch_index is None:
            prefix.append(play)
            break

        events = play.get('playEvents', [])
        if pitch_index >= len(events) - 1:
            prefix.append(play)
            break

        # The feed can already contain a later pitch/result when an earlier
        # pitch is being queued for animation. Use the earlier pitch's count
        # and do not let the later play result/runners leak into its snapshot.
        about = dict(play.get('about') or {})
        about['isComplete'] = False
        prefix.append({
            **play,
            'about': about,
            'playEvents': events[:pitch_index + 1],
            'result': {},
            'runners': [],
        })
        break
    return prefix


def _runs_through_plays(all_plays: list) -> dict:
    """Count scored runners through a feed prefix, split by batting team."""
    runs = {'away': 0, 'home': 0}
    for play_index, play in enumerate(all_plays):
        half = (play.get('about') or {}).get('halfInning')
        side = 'away' if half == 'top' else 'home' if half == 'bottom' else None
        if side is None:
            continue
        counted = set()
        for runner_index, runner in enumerate(play.get('runners') or []):
            movement = runner.get('movement') or {}
            runner_id = ((runner.get('details') or {}).get('runner') or {}).get('id')
            key = (play_index, runner_id if runner_id is not None else runner_index)
            if key in counted:
                continue
            if (movement.get('end') == 'score' or movement.get('isScoringEvent')) \
                    and not movement.get('isOut'):
                runs[side] += 1
                counted.add(key)
    return runs


def _inning_ordinal(number) -> str | None:
    """Format an inning number as the MLB ordinal used by the scorebug."""
    if number is None:
        return None
    try:
        value = int(number)
    except (TypeError, ValueError):
        return str(number)
    suffix = 'th'
    if value % 100 not in (11, 12, 13):
        suffix = {1: 'st', 2: 'nd', 3: 'rd'}.get(value % 10, 'th')
    return f'{value}{suffix}'


def _game_state_snapshot(data: dict, target_play: dict,
                         target_pitch: dict, pitch_index: Optional[int]) -> dict:
    """Build the scoreboard state as of one pitch, not the newest feed event.

    The live feed can contain several completed plays before the frontend has
    animated any of them. Keeping this snapshot on each trajectory lets the
    frontend commit score/count changes one animation at a time instead of
    asking ``/api/game-state`` for the already-advanced current feed.
    """
    game_data = data.get('gameData', {})
    live_data = data.get('liveData', {})
    linescore = live_data.get('linescore', {}) or {}
    all_plays = live_data.get('plays', {}).get('allPlays') or []
    prefix = _prefix_through_pitch(data, target_play, pitch_index)
    about = target_play.get('about') or {}
    matchup = target_play.get('matchup') or {}
    target_count = target_pitch.get('count') or {}
    balls, strikes = _current_count(prefix)
    if balls is None:
        balls = target_count.get('balls')
    if strikes is None:
        strikes = target_count.get('strikes')

    target_is_latest = bool(all_plays) and prefix and prefix[-1] is all_plays[-1]
    target_events = target_play.get('playEvents') or []
    target_is_final_event = pitch_index is None or pitch_index >= len(target_events) - 1
    live_totals = (linescore.get('teams') or {})
    derived_runs = _runs_through_plays(prefix)
    score = {}
    for side in ('away', 'home'):
        live = live_totals.get(side) or {}
        score[side] = {
            # A latest-play snapshot can use the authoritative linescore. For
            # an older queued pitch, only runs scored through that pitch belong
            # in the scoreboard state.
            'runs': live.get('runs') if target_is_latest and target_is_final_event
                    and live.get('runs') is not None else derived_runs[side],
            'hits': live.get('hits'),
            'errors': live.get('errors'),
        }

    teams = {}
    for side in ('away', 'home'):
        team = (game_data.get('teams') or {}).get(side) or {}
        teams[side] = {
            'name': team.get('name', '—'),
            'abbreviation': team.get('abbreviation', side.upper()),
            'id': team.get('id'),
        }

    inning_number = about.get('inning', linescore.get('currentInning'))
    half = about.get('halfInning')
    is_top = half == 'top' if half else linescore.get('isTopInning')
    current_pitcher_id = matchup.get('pitcher', {}).get('id')
    pitches_thrown = sum(
        1 for play in prefix
        if play.get('matchup', {}).get('pitcher', {}).get('id') == current_pitcher_id
        for event in play.get('playEvents', []) if event.get('isPitch')
    )
    outs = target_count.get('outs')
    if outs is None:
        outs = linescore.get('outs') if target_is_latest else None

    # Preserve the same matchup stat fields as /api/game-state so committing a
    # historical snapshot does not blank the scorebug's batter/pitcher popovers.
    box_teams = (live_data.get('boxscore') or {}).get('teams') or {}

    def box_entry(player_id):
        for side in ('away', 'home'):
            players = (box_teams.get(side) or {}).get('players') or {}
            entry = players.get(f'ID{player_id}') or players.get(str(player_id))
            if entry:
                return entry
        return {}

    batter_entry = box_entry(matchup.get('batter', {}).get('id'))
    batter_stats = batter_entry.get('stats', {}).get('batting') or {}
    batter_line = None
    if batter_stats.get('atBats') is not None and batter_stats.get('hits') is not None:
        batter_line = {
            'atBats': batter_stats.get('atBats'),
            'hits': batter_stats.get('hits'),
        }
    batter_season_stats = batter_entry.get('seasonStats', {}).get('batting') or {}
    pitcher_season_stats = box_entry(current_pitcher_id).get('seasonStats', {}).get('pitching') or {}
    status = game_data.get('status', {})
    return {
        'success': True,
        'teams': teams,
        'score': score,
        'inning': {
            'number': inning_number,
            'ordinal': about.get('inningOrdinal') or _inning_ordinal(inning_number),
            'state': 'Top' if is_top else 'Bottom' if half else linescore.get('inningState'),
            'isTop': is_top,
        },
        'outs': outs,
        'count': {'balls': balls, 'strikes': strikes},
        'bases': _occupied_bases(prefix),
        'pitcher': matchup.get('pitcher', {}).get('fullName', '—'),
        'pitcherId': matchup.get('pitcher', {}).get('id'),
        'batter': matchup.get('batter', {}).get('fullName', '—'),

        'batterLine': batter_line,
        'pitchNumber': target_pitch.get('pitchNumber'),
        'pitchesThrown': pitches_thrown,
        'gameState': status.get('detailedState'),
        'isLive': status.get('abstractGameState') == 'Live',
        'venue': (game_data.get('venue') or {}).get('name'),
        'batterSeason': {
            'avg': batter_season_stats.get('avg'),
            'obp': batter_season_stats.get('obp'),
            'slg': batter_season_stats.get('slg'),
            'hr': batter_season_stats.get('homeRuns'),
            'rbi': batter_season_stats.get('rbi'),
        },
        'pitcherSeason': {
            'era': pitcher_season_stats.get('era'),
            'whip': pitcher_season_stats.get('whip'),
            'wins': pitcher_season_stats.get('wins'),
            'losses': pitcher_season_stats.get('losses'),
            'so': pitcher_season_stats.get('strikeOuts'),
            'ip': pitcher_season_stats.get('inningsPitched'),
        },
    }


# ---------------------------------------------------------------------------
# Lightweight status endpoint + broadcast game-state endpoint
# ---------------------------------------------------------------------------


def _game_status_snapshot(data: dict) -> dict:
    """Extract only the fields needed while the scoreboard is frozen."""
    game_data = data.get('gameData', {})
    live_data = data.get('liveData', {})
    plays = live_data.get('plays') or {}
    current_play = plays.get('currentPlay') or {}
    matchup = current_play.get('matchup') or {}
    pitcher = matchup.get('pitcher') or {}

    # During a delay or between play updates ``currentPlay`` can briefly be
    # absent. The latest play still carries the active pitcher, so use it as a
    # cheap fallback without running the full scoreboard parser.
    if not pitcher:
        for play in reversed(plays.get('allPlays') or []):
            pitcher = ((play.get('matchup') or {}).get('pitcher') or {})
            if pitcher:
                break

    status = game_data.get('status') or {}
    abstract_state = status.get('abstractGameState')
    detailed_state = status.get('detailedState')
    return {
        "success": True,
        "gameState": detailed_state,
        "isLive": abstract_state == "Live",
        "abstractGameState": abstract_state,
        "detailedState": detailed_state,
        "pitcher": pitcher.get('fullName'),
        "pitcherId": pitcher.get('id'),
    }


@app.get("/api/game-status")
def get_game_status(game_pk: str = GAME_PK):
    """Return delay/review/live status and the active pitcher only.

    This endpoint intentionally avoids score, box-score, count, and season-stat
    parsing. The frozen scorebug polls it once per second so a delay or pitching
    change can appear without fetching/building the full scoreboard payload.
    """
    print(f"GAME STATUS... Polling game {game_pk}")
    response = requests.get(_feed_url(game_pk))
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch from MLB API")
    data = response.json()
    try:
        return _game_status_snapshot(data)
    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Game-status parsing failed: {e}")


@app.get("/api/game-state")
def get_game_state(game_pk: str = GAME_PK):
    """Return broadcast-style game state from the MLB live feed.

    Drives the scorebug HUD in the frontend: teams + score, inning/half,
    outs, ball-strike count, occupied bases, the current pitcher/batter
    matchup, and pitch totals. Values that aren't meaningful yet (e.g. no
    current play during the middle of an inning) come back as ``None`` so the
    frontend can render a dash instead of a stale number.
    """
    print(f"GAME STATE... Polling game {game_pk}")
    response = requests.get(_feed_url(game_pk))
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch from MLB API")
    data = response.json()
    try:
        game_data = data.get('gameData', {})
        live_data = data.get('liveData', {})

        teams = {}
        for side in ('away', 'home'):
            t = game_data.get('teams', {}).get(side, {})
            teams[side] = {
                "name": t.get('name', '—'),
                "abbreviation": t.get('abbreviation', side.upper()),
                "id": t.get('id'),
            }

        linescore = live_data.get('linescore', {}) or {}
        score = {}
        for side in ('away', 'home'):
            st = (linescore.get('teams') or {}).get(side, {})
            score[side] = {
                "runs": st.get('runs'),
                "hits": st.get('hits'),
                "errors": st.get('errors'),
            }

        current_play = (live_data.get('plays') or {}).get('currentPlay') or {}
        matchup = current_play.get('matchup', {})
        all_plays = (live_data.get('plays') or {}).get('allPlays', [])

        # Count: prefer the current play's count (authoritative), then derive
        # from the play log, and only fall back to the linescore — which can
        # lag the play log for a beat after a pitch — as a last resort.
        count = current_play.get('count') or {}
        balls = count.get('balls')
        strikes = count.get('strikes')
        outs = count.get('outs')
        if balls is None or strikes is None:
            log_balls, log_strikes = _current_count(all_plays)
            if balls is None:
                balls = log_balls
            if strikes is None:
                strikes = log_strikes
        if balls is None:
            balls = linescore.get('balls')
        if strikes is None:
            strikes = linescore.get('strikes')
        if outs is None:
            outs = linescore.get('outs')

        # Occupied bases, computed by replaying the current half-inning's
        # runner movements (the feed has no single "runnersOnBase" field).
        bases = _occupied_bases(all_plays)

        # Pitch total for the current pitcher, mirroring _build_trajectory_payload.
        pitcher_id = matchup.get('pitcher', {}).get('id')
        pitches_thrown = sum(
            1 for play in all_plays
            if play.get('matchup', {}).get('pitcher', {}).get('id') == pitcher_id
            for event in play.get('playEvents', []) if event.get('isPitch')
        )

        # Current batter's game batting line (hits–atBats) for the scorebug.
        # Prefer the official boxscore stats (whose players dict is keyed by
        # "ID<playerId>"), falling back to tallying allPlays if the batter
        # isn't in the boxscore yet.
        batter_line = None
        batter_id = matchup.get('batter', {}).get('id')
        box_teams = (live_data.get('boxscore') or {}).get('teams') or {}
        if batter_id:
            for side in ('away', 'home'):
                batters = (box_teams.get(side) or {}).get('batters') or []
                if batter_id not in batters:
                    continue
                players = (box_teams.get(side) or {}).get('players') or {}
                stats = (
                    players.get(f'ID{batter_id}') or players.get(str(batter_id)) or {}
                ).get('stats', {}).get('batting') or {}
                if stats.get('atBats') is not None and stats.get('hits') is not None:
                    batter_line = {"atBats": stats['atBats'], "hits": stats['hits']}
                break
            if batter_line is None:
                at_bats = 0
                hits = 0
                for play in (live_data.get('plays') or {}).get('allPlays', []):
                    if play.get('matchup', {}).get('batter', {}).get('id') != batter_id:
                        continue
                    result = play.get('result', {})
                    if result.get('type') != 'atBat':
                        continue
                    event = result.get('event') or ''
                    if event not in _NON_AT_BAT_EVENTS:
                        at_bats += 1
                    if event in _HIT_EVENTS:
                        hits += 1
                batter_line = {"atBats": at_bats, "hits": hits}

        # Season stats for the current batter/pitcher (hover popovers in the
        # scorebug): AVG/OBP/SLG for the batter, ERA/WHIP for the pitcher.
        def _player_entry(player_id):
            """Look up a boxscore player entry by id (keys are 'ID<id>')."""
            for side in ('away', 'home'):
                players = (box_teams.get(side) or {}).get('players') or {}
                entry = players.get(f'ID{player_id}') or players.get(str(player_id))
                if entry:
                    return entry
            return {}

        batter_season = None
        if batter_id:
            season = _player_entry(batter_id).get('seasonStats', {}).get('batting') or {}
            batter_season = {
                "avg": season.get('avg'),
                "obp": season.get('obp'),
                "slg": season.get('slg'),
                "hr": season.get('homeRuns'),
                "rbi": season.get('rbi'),
            }

        pitcher_season = None
        if pitcher_id:
            season = _player_entry(pitcher_id).get('seasonStats', {}).get('pitching') or {}
            pitcher_season = {
                "era": season.get('era'),
                "whip": season.get('whip'),
                "wins": season.get('wins'),
                "losses": season.get('losses'),
                "so": season.get('strikeOuts'),
                "ip": season.get('inningsPitched'),
            }

        status = game_data.get('status', {})
        return {
            "success": True,
            "teams": teams,
            "score": score,
            "inning": {
                "number": linescore.get('currentInning'),
                "ordinal": linescore.get('currentInningOrdinal'),
                "state": linescore.get('inningState'),
                "isTop": linescore.get('isTopInning'),
            },
            "outs": outs,
            "count": {"balls": balls, "strikes": strikes},
            "bases": bases,
            "pitcher": matchup.get('pitcher', {}).get('fullName', '—'),
            "pitcherId": matchup.get('pitcher', {}).get('id'),
            "batter": matchup.get('batter', {}).get('fullName', '—'),
            "batterLine": batter_line,
            "pitchNumber": current_play.get('pitchNumber'),
            "pitchesThrown": pitches_thrown,
            "gameState": status.get('detailedState'),
            "isLive": status.get('abstractGameState') == 'Live',
            "venue": (game_data.get('venue') or {}).get('name'),
            # Season stats for the current matchup, for the hover popovers.
            "batterSeason": batter_season,
            "pitcherSeason": pitcher_season,
        }
    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Game-state parsing failed: {e}")


# ---------------------------------------------------------------------------
# Box-score endpoint
# ---------------------------------------------------------------------------


@app.get("/api/box-score")
def get_box_score(game_pk: str = GAME_PK):
    """Return both teams' full batting and pitching lines for the game.

    Powers the clickable box-score panel in the scorebug HUD. Batting rows
    carry the player's game line (AB, R, H, RBI, BB, SO) plus season AVG;
    pitching rows carry the game line (IP, H, R, ER, BB, SO) plus season
    ERA/WHIP. Also includes a ``linescore`` block (runs by inning plus the
    running R/H/E totals) for the scoreboard team line at the top of the
    panel. Fetched on demand (only when the user opens the panel), since
    unlike game-state it isn't needed every second.
    """
    print(f"BOX SCORE... Polling game {game_pk}")
    response = requests.get(_feed_url(game_pk))
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch from MLB API")
    data = response.json()
    try:
        game_data = data.get('gameData', {})
        live_data = data.get('liveData', {})
        box_teams = (live_data.get('boxscore') or {}).get('teams') or {}

        def _entry(player_id):
            """Look up a boxscore player entry by id (keys are 'ID<id>')."""
            for side in ('away', 'home'):
                players = (box_teams.get(side) or {}).get('players') or {}
                entry = players.get(f'ID{player_id}') or players.get(str(player_id))
                if entry:
                    return entry
            return {}

        result = {"success": True, "teams": {}}
        for side in ('away', 'home'):
            bt = box_teams.get(side) or {}
            game_team = (game_data.get('teams') or {}).get(side) or {}

            batting = []
            for pid in bt.get('batters') or []:
                entry = _entry(pid)
                stats = entry.get('stats', {}).get('batting') or {}
                season = entry.get('seasonStats', {}).get('batting') or {}
                batting.append({
                    "id": pid,
                    "name": (entry.get('person') or {}).get('fullName', '—'),
                    "position": (entry.get('position') or {}).get('abbreviation', ''),
                    "ab": stats.get('atBats'),
                    "r": stats.get('runs'),
                    "h": stats.get('hits'),
                    "rbi": stats.get('rbi'),
                    "bb": stats.get('baseOnBalls'),
                    "so": stats.get('strikeOuts'),
                    "avg": season.get('avg'),
                })

            pitching = []
            for pid in bt.get('pitchers') or []:
                entry = _entry(pid)
                stats = entry.get('stats', {}).get('pitching') or {}
                season = entry.get('seasonStats', {}).get('pitching') or {}
                pitching.append({
                    "id": pid,
                    "name": (entry.get('person') or {}).get('fullName', '—'),
                    "ip": stats.get('inningsPitched'),
                    "h": stats.get('hits'),
                    "r": stats.get('runs'),
                    "er": stats.get('earnedRuns'),
                    "bb": stats.get('baseOnBalls'),
                    "so": stats.get('strikeOuts'),
                    "era": season.get('era'),
                    "whip": season.get('whip'),
                })

            result["teams"][side] = {
                "name": game_team.get('name') or (bt.get('team') or {}).get('name', '—'),
                "abbreviation": game_team.get('abbreviation', side.upper()),
                "batting": batting,
                "pitching": pitching,
            }

        # Scoreboard team line for the top of the box-score panel: runs by
        # inning (the API omits `runs` for half-innings not yet played, which
        # the frontend renders as an X), plus the running R/H/E totals. Each
        # inning keeps the API's nested {runs: ...} shape per side, which the
        # frontend's Linescore reads as ``inning[side].runs``.
        linescore = live_data.get('linescore', {}) or {}
        innings = []
        for inn in linescore.get('innings') or []:
            innings.append({
                "num": inn.get('num'),
                "away": {"runs": (inn.get('away') or {}).get('runs')},
                "home": {"runs": (inn.get('home') or {}).get('runs')},
            })
        result["linescore"] = {
            "currentInning": linescore.get('currentInning'),
            "innings": innings,
            "teams": {
                side: {
                    "runs": ((linescore.get('teams') or {}).get(side) or {}).get('runs'),
                    "hits": ((linescore.get('teams') or {}).get(side) or {}).get('hits'),
                    "errors": ((linescore.get('teams') or {}).get(side) or {}).get('errors'),
                }
                for side in ('away', 'home')
            },
        }
        return result
    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Box-score parsing failed: {e}")


# ---------------------------------------------------------------------------
# Live-game search endpoint
# ---------------------------------------------------------------------------

@app.get("/api/live-games")
def get_live_games():
    """List MLB games currently in progress.

    Fetches the MLB Stats API schedule for a short window around today (UTC)
    and returns the games whose abstract state is "Live" (in progress,
    delayed, etc.), with the team/score/inning summary the frontend's
    live-games drawer needs to let the user pick a game to watch.
    """
    schedule_url = "https://statsapi.mlb.com/api/v1/schedule"
    today = datetime.now(timezone.utc).date()
    try:
        resp = requests.get(
            schedule_url,
            params={
                "sportId": 1,
                "startDate": (today - timedelta(days=1)).strftime("%Y-%m-%d"),
                "endDate": (today + timedelta(days=1)).strftime("%Y-%m-%d"),
                "hydrate": "linescore,team,venue",
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Failed to fetch MLB schedule")

    games = []
    for date_block in data.get("dates", []):
        for game in date_block.get("games", []):
            status = game.get("status", {})
            if status.get("abstractGameState") != "Live":
                continue
            linescore = game.get("linescore") or {}
            teams = {}
            for side in ("away", "home"):
                t = (game.get("teams") or {}).get(side, {})
                team = t.get("team", {})
                teams[side] = {
                    "name": team.get("name", "—"),
                    "abbreviation": team.get("abbreviation", side.upper()),
                    "id": team.get("id"),
                    "score": t.get("score"),
                }
            games.append({
                "game_pk": game.get("gamePk"),
                "game_date": game.get("gameDate"),
                "status": status.get("detailedState", "Live"),
                "venue": (game.get("venue") or {}).get("name", "—"),
                "teams": teams,
                "inning": {
                    "number": linescore.get("currentInning"),
                    "ordinal": linescore.get("currentInningOrdinal"),
                    "isTop": linescore.get("isTopInning"),
                    "state": linescore.get("inningState"),
                },
            })
    return {"success": True, "games": games}


# ── League-average pitch break (Baseball Savant Statcast CSV) ─────────────────
# League-average induced break by pitch type, aggregated from Baseball Savant's
# statcast_search CSV export (https://baseballsavant.mlb.com/csv-docs). The CSV
# returns per-pitch rows with pfx_x/pfx_z in FEET; we aggregate the last N days
# of the current season, mirroring left-handed pitchers' horizontal break to a
# right-handed convention (pfxX > 0 = glove side for a RHP), convert to inches,
# and cache for a few hours so the frontend's H/V Break comparison rows don't
# hammer Savant on every load. The window is short enough to stay light (each
# daily request is a few thousand pitches, well under Savant's 25k-row CSV cap).
BREAK_AVERAGES_WINDOW_DAYS = 14
BREAK_AVERAGES_CACHE_TTL_SECONDS = 6 * 60 * 60

_break_averages_lock = threading.Lock()
_break_averages_cache = {"fetched_at": 0.0, "data": None}


def _savant_day_rows(day):
    """Fetch one day of Statcast pitcher rows from the Savant CSV export."""
    date_str = day.strftime("%Y-%m-%d")
    url = (
        "https://baseballsavant.mlb.com/statcast_search/csv"
        f"?all=true&type=details&player_type=pitcher&hfSea={day.year}%7C"
        f"&game_date_gt={date_str}&game_date_lt={date_str}"
    )
    resp = requests.get(url, timeout=45)
    resp.raise_for_status()
    # utf-8-sig strips the BOM that otherwise prefixes the first column name.
    return list(csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig"))))


def _fetch_break_averages():
    """Aggregate mean pfx_x/pfx_z (inches) by pitch type over the last N days."""
    today = datetime.now(timezone.utc).date()
    days = [today - timedelta(days=i) for i in range(BREAK_AVERAGES_WINDOW_DAYS)]
    sums = {}  # pitch_type -> [count, sum_x, sum_z]
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(_savant_day_rows, day) for day in days]
        for future in futures:
            try:
                rows = future.result()
            except Exception:
                # A failed day shouldn't sink the whole average.
                continue
            for row in rows:
                pitch_type = (row.get("pitch_type") or "").strip()
                if not pitch_type:
                    continue
                try:
                    # Savant's CSV exports pfx in feet; the app displays inches.
                    x = float(row["pfx_x"]) * 12.0
                    z = float(row["pfx_z"]) * 12.0
                except (KeyError, TypeError, ValueError):
                    continue
                if row.get("p_throws") == "L":
                    x = -x
                acc = sums.setdefault(pitch_type, [0, 0.0, 0.0])
                acc[0] += 1
                acc[1] += x
                acc[2] += z

    averages = {}
    for pitch_type, (n, sum_x, sum_z) in sums.items():
        if n >= 25:  # skip tiny samples
            averages[pitch_type] = {
                "x": round(sum_x / n, 2),
                "z": round(sum_z / n, 2),
                "n": n,
            }
    return averages


def _get_cached_break_averages():
    """Return cached league averages, refreshing when stale (single-flight)."""
    now = time.time()
    with _break_averages_lock:
        if _break_averages_cache["data"] and now - _break_averages_cache["fetched_at"] < BREAK_AVERAGES_CACHE_TTL_SECONDS:
            return _break_averages_cache["data"]
        try:
            data = _fetch_break_averages()
            _break_averages_cache["fetched_at"] = now
            _break_averages_cache["data"] = data
        except Exception:
            # Keep serving stale data; retry in ~5 min instead of waiting out
            # the full TTL so a transient Savant outage doesn't stick.
            data = _break_averages_cache["data"] or {}
            _break_averages_cache["fetched_at"] = now - BREAK_AVERAGES_CACHE_TTL_SECONDS + 300
        return data


# ── Local xBA (expected batting average) model ───────────────────────────────
# xBA is computed locally from each batted ball's exit velocity and launch
# angle (plus the batter's sprint speed on ground balls) instead of waiting on
# Savant's per-pitch statcast export, which lags for live games. The model is
# a smoothed (EV, LA) -> P(hit) grid built from recent Savant statcast data
# (the same CSV export the break averages use): each batted ball is binned by
# exit velocity and launch angle, a hit is an event in
# {single, double, triple, home_run}, and the hit/count grids are Gaussian-
# blurred before dividing so sparse bins stay stable. Validated against
# Savant's own `estimated_ba_using_speedangle` (r ~ 0.97, MAE ~ 0.047).
# Sprint speed only moves ground balls: +1 ft/s above the league average
# (~27.3 ft/s) adds ~0.010 to ground-ball xBA (faster runners beat out more
# infield hits), blended to zero by 10 degrees of launch angle.
_XBA_HIT_EVENTS = {"single", "double", "triple", "home_run"}
_XBA_GRID_DAYS = 45
_XBA_GRID_TTL_SECONDS = 6 * 60 * 60
_XBA_GRID_SIGMA = 1.5  # bins, for the Gaussian blur over the EV/LA grid
_XBA_EV_MIN, _XBA_EV_MAX, _XBA_EV_STEP = 40.0, 125.0, 2.0
_XBA_LA_MIN, _XBA_LA_MAX, _XBA_LA_STEP = -50.0, 80.0, 2.0
_XBA_SPRINT_LEAGUE_AVG = 27.3  # ft/s
_XBA_SPRINT_GROUND_SLOPE = 0.0097  # per ft/s on ground balls (OLS-calibrated)

_xba_grid_lock = threading.Lock()
_xba_grid_cache = {"fetched_at": 0.0, "grid": None, "building": False}

_sprint_speed_lock = threading.Lock()
_sprint_speed_cache = {"fetched_at": 0.0, "by_player": {}}
_SPRINT_SPEED_TTL_SECONDS = 6 * 60 * 60


def _gaussian_blur(a, sigma):
    """Separable Gaussian blur on a 2D numpy array (no scipy dependency)."""
    radius = max(1, int(3 * sigma))
    x = np.arange(-radius, radius + 1)
    kernel = np.exp(-0.5 * (x / sigma) ** 2)
    kernel = kernel / kernel.sum()
    a = np.apply_along_axis(lambda m: np.convolve(m, kernel, mode="same"), axis=1, arr=a)
    a = np.apply_along_axis(lambda m: np.convolve(m, kernel, mode="same"), axis=0, arr=a)
    return a


def _build_xba_grid():
    """Build the smoothed (EV, LA) -> P(hit) grid from recent statcast data."""
    today = datetime.now(timezone.utc).date()
    days = [today - timedelta(days=i) for i in range(_XBA_GRID_DAYS)]
    ev_bins = int(round((_XBA_EV_MAX - _XBA_EV_MIN) / _XBA_EV_STEP)) + 1
    la_bins = int(round((_XBA_LA_MAX - _XBA_LA_MIN) / _XBA_LA_STEP)) + 1
    counts = np.zeros((la_bins, ev_bins))
    hits = np.zeros((la_bins, ev_bins))
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(_savant_day_rows, day) for day in days]
        for future in futures:
            try:
                rows = future.result()
            except Exception:
                continue
            for row in rows:
                ev = (row.get("launch_speed") or "").strip()
                la = (row.get("launch_angle") or "").strip()
                events = (row.get("events") or "").strip().lower()
                if not ev or not la or not events:
                    continue
                try:
                    ev = float(ev)
                    la = float(la)
                except ValueError:
                    continue
                if not (_XBA_EV_MIN <= ev <= _XBA_EV_MAX
                        and _XBA_LA_MIN <= la <= _XBA_LA_MAX):
                    continue
                ei = min(max(int(round((ev - _XBA_EV_MIN) / _XBA_EV_STEP)), 0), ev_bins - 1)
                li = min(max(int(round((la - _XBA_LA_MIN) / _XBA_LA_STEP)), 0), la_bins - 1)
                counts[li, ei] += 1
                hits[li, ei] += 1 if events in _XBA_HIT_EVENTS else 0
    if counts.sum() == 0:
        raise ValueError("no batted-ball data in statcast window")
    with np.errstate(invalid="ignore", divide="ignore"):
        rate = np.where(
            counts > 0,
            _gaussian_blur(hits, _XBA_GRID_SIGMA) / _gaussian_blur(counts, _XBA_GRID_SIGMA),
            np.nan,
        )
    return rate


def _xba_grid():
    """Return the cached xBA grid, kicking off a background rebuild when stale.

    The first build runs in a background thread so the first trajectory poll
    isn't blocked for the ~1-minute statcast fetch; until it's ready the grid
    is None and xBA simply shows a dash.
    """
    now = time.time()
    with _xba_grid_lock:
        if (_xba_grid_cache["grid"] is not None
                and now - _xba_grid_cache["fetched_at"] < _XBA_GRID_TTL_SECONDS):
            return _xba_grid_cache["grid"]
        if not _xba_grid_cache["building"]:
            _xba_grid_cache["building"] = True

            def _rebuild():
                try:
                    grid = _build_xba_grid()
                    with _xba_grid_lock:
                        _xba_grid_cache["grid"] = grid
                        _xba_grid_cache["fetched_at"] = time.time()
                except Exception:
                    pass  # keep serving the old grid (or None) on failure
                finally:
                    with _xba_grid_lock:
                        _xba_grid_cache["building"] = False

            threading.Thread(target=_rebuild, daemon=True).start()
        return _xba_grid_cache["grid"]


def _sprint_speed_by_player():
    """Return {player_id: sprint_speed} from Savant's leaderboard, cached."""
    now = time.time()
    with _sprint_speed_lock:
        if (_sprint_speed_cache["by_player"]
                and now - _sprint_speed_cache["fetched_at"] < _SPRINT_SPEED_TTL_SECONDS):
            return _sprint_speed_cache["by_player"]
        try:
            resp = requests.get(
                "https://baseballsavant.mlb.com/leaderboard/sprint_speed"
                f"?type=year&year={datetime.now(timezone.utc).year}&min=10"
                "&sort=1&sortDir=desc&csv=true",
                timeout=30,
            )
            resp.raise_for_status()
            by_player = {}
            for row in csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig"))):
                speed = (row.get("sprint_speed") or "").strip()
                pid = (row.get("player_id") or "").strip()
                if speed and pid:
                    try:
                        by_player[pid] = float(speed)
                    except ValueError:
                        pass
            if by_player:
                _sprint_speed_cache.update({"fetched_at": now, "by_player": by_player})
        except Exception:
            pass  # serve stale speeds on failure
        return _sprint_speed_cache["by_player"]


def _sprint_speed_for_batter(batter_id):
    """Return a batter's sprint speed (ft/s), or None when unknown."""
    if batter_id is None:
        return None
    return _sprint_speed_by_player().get(str(batter_id))


def _compute_xba(launch_speed, launch_angle, sprint_speed=None):
    """Compute xBA from exit velocity, launch angle, and (on ground balls) sprint speed.

    Returns a rounded probability in [0.02, 0.99], or None when the pitch has
    no batted-ball data (or the model grid isn't ready) so the frontend shows a
    dash.
    """
    if launch_speed is None or launch_angle is None:
        return None
    try:
        ev = float(launch_speed)
        la = float(launch_angle)
    except (TypeError, ValueError):
        return None
    if not (_XBA_EV_MIN <= ev <= _XBA_EV_MAX and _XBA_LA_MIN <= la <= _XBA_LA_MAX):
        return None
    grid = _xba_grid()
    if grid is None:
        return None
    ei = int(round((ev - _XBA_EV_MIN) / _XBA_EV_STEP))
    li = int(round((la - _XBA_LA_MIN) / _XBA_LA_STEP))
    if not (0 <= ei < grid.shape[1] and 0 <= li < grid.shape[0]):
        return None
    base = grid[li, ei]
    if math.isnan(base):
        return None
    xba = float(base)
    if sprint_speed is not None:
        # Sprint speed only matters on ground balls (LA <= ~10 deg): faster
        # runners turn more grounders into infield hits. Ramp to zero by 10 deg
        # so there's no discontinuity between ground balls and liners.
        weight = min(max((10.0 - la) / 10.0, 0.0), 1.0)
        xba += _XBA_SPRINT_GROUND_SLOPE * (sprint_speed - _XBA_SPRINT_LEAGUE_AVG) * weight
    return round(min(max(xba, 0.02), 0.99), 3)


@app.get("/api/break-averages")
def get_break_averages():
    """League-average induced break (inches) by pitch type, from Baseball Savant."""
    averages = _get_cached_break_averages()
    return {
        "success": True,
        "season": datetime.now(timezone.utc).year,
        "window_days": BREAK_AVERAGES_WINDOW_DAYS,
        "averages": averages,
    }


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
