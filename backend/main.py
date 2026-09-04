import os
import sys
import math
import csv
import hashlib
import io
import json
import time
import threading
import unicodedata
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


# Hard ceiling on each MLB live-feed fetch. The statsapi feed is normally
# sub-second, but during a pitching change / inning break it can stall; without
# this a stalled fetch would hang the polling endpoints (trajectory, batted
# ball) indefinitely. On timeout we raise a clean 502 so the client can retry.
MLB_FEED_TIMEOUT_SECONDS = 15

# The live frontend polls several endpoints (trajectory, batted-ball,
# game-state, game-status) on ~1s intervals, and each used to re-fetch and
# re-parse the full MLB live feed independently. Cache the parsed feed per
# game for a short TTL so polls that land within the same window share one
# fetch. App.jsx fires trajectory + batted-ball in the same tick, and the
# scorebug's game-state/status poll sits on a parallel timer, so this cuts the
# statsapi.mlb.com request volume dramatically without making the feed any
# staler than the natural poll cadence (a refreshed feed is at most ~1s old).
# The trajectory/batted-ball *response* caches only save the simulation build;
# this feed cache is what stops the repeated external fetches.
FEED_CACHE_TTL_SECONDS = 1.0
_FEED_CACHE: dict[str, dict] = {}
_FEED_CACHE_GUARD = threading.RLock()
# Per-game single-flight locks so polls for DIFFERENT games' cold fetches
# aren't serialized, while concurrent polls for the SAME game that all miss the
# TTL (a slow feed, or a tight cluster of ticks) share one in-flight request
# instead of each issuing their own. A long session can poll many games, and
# each distinct game registers a lock, so the window is bounded (mirroring the
# response-cursor caches) by ``_prune_feed_build_locks``.
_FEED_BUILD_LOCKS: dict[str, threading.Lock] = {}
# ``time.monotonic()`` of the last time each game's feed lock was touched, used
# by the LRU-style eviction below. Kept parallel to ``_FEED_BUILD_LOCKS``.
_FEED_BUILD_LOCKS_LAST_USED: dict[str, float] = {}
# Cap on distinct games with a cached feed lock, mirroring the bounded cursor
# cache window. Kept generous since a live frontend only tracks a handful of
# games at once.
_FEED_BUILD_LOCKS_MAX_ENTRIES = 64
# Hard cap on live parsed-feed entries resident in ``_FEED_CACHE``. The TTL
# alone only bounds how *old* an entry can be, not how many live entries a
# burst of polls across many games can hold (each is the full ~1MB parsed
# feed), and ``_FEED_BUILD_LOCKS_MAX_ENTRIES`` bounds locks, not the payloads
# they serve. Eviction is LRU-by-fetch-time, run inside the same prune.
_FEED_CACHE_MAX_ENTRIES = 64


def _prune_feed_build_locks() -> None:
    """Bound the per-game feed single-flight locks AND parsed feeds (LRU).

    Heavy sessions poll many games; without a cap each distinct game_pk would
    grow a lock entry (and a parsed feed) forever. Mirroring the
    response-cursor caches, once ``_FEED_BUILD_LOCKS`` passes its max entries
    the least-recently-used idle locks are evicted. A lock that is currently
    held (an in-flight fetch) is never evicted, so single-flight correctness is
    preserved: a later poll just lazily recreates a fresh lock, at worst costing
    one extra fetch. Expired feed-cache entries are dropped at the same time so
    stale games no longer pin their (potentially large) parsed feeds, and any
    remaining live entries over ``_FEED_CACHE_MAX_ENTRIES`` are also evicted
    (LRU by fetch time) so a burst across many games can't pin unbounded
    parsed JSON.

    The caller must not hold any feed build lock; only ``_FEED_CACHE_GUARD`` is
    acquired here.
    """
    max_entries = _FEED_BUILD_LOCKS_MAX_ENTRIES
    if max_entries < 1:
        return
    feed_max = _FEED_CACHE_MAX_ENTRIES
    now = time.monotonic()
    with _FEED_CACHE_GUARD:
        # Free already-expired feed payloads first: they can't be served, so
        # keeping them only wastes the parsed JSON and pins dead game_pks.
        for game, entry in list(_FEED_CACHE.items()):
            if now - entry["fetched_at"] >= FEED_CACHE_TTL_SECONDS:
                _FEED_CACHE.pop(game, None)

        # Hard cap on live entries so many games polled within the same TTL
        # window can't pin large parsed feeds without bound. Evict the oldest
        # fetched, skipping a game whose fetch is currently in flight so we
        # don't discard a feed that just landed.
        if feed_max >= 1 and len(_FEED_CACHE) > feed_max:
            feed_candidates = sorted(
                _FEED_CACHE.keys(),
                key=lambda g: _FEED_CACHE[g]["fetched_at"],
            )
            excess_feed = len(_FEED_CACHE) - feed_max
            for game in feed_candidates:
                if excess_feed <= 0:
                    break
                lock = _FEED_BUILD_LOCKS.get(game)
                if lock is not None and lock.locked():
                    # In-flight fetch for this game; let it finish and land
                    # before evicting.
                    continue
                _FEED_CACHE.pop(game, None)
                excess_feed -= 1

        excess = len(_FEED_BUILD_LOCKS) - max_entries
        if excess <= 0:
            return
        candidates = sorted(
            (g for g in _FEED_BUILD_LOCKS if g in _FEED_BUILD_LOCKS_LAST_USED),
            key=lambda g: _FEED_BUILD_LOCKS_LAST_USED[g],
        )
        for game in candidates:
            if excess <= 0:
                break
            lock = _FEED_BUILD_LOCKS.get(game)
            if lock is None or lock.locked():
                # An in-flight fetch owns this lock; skip it and try another,
                # leaving the window slightly over cap until the fetch releases.
                continue
            _FEED_BUILD_LOCKS.pop(game, None)
            _FEED_BUILD_LOCKS_LAST_USED.pop(game, None)
            excess -= 1


def _clear_feed_cache() -> None:
    """Drop every cached feed and its single-flight lock (test helper)."""
    with _FEED_CACHE_GUARD:
        _FEED_CACHE.clear()
        _FEED_BUILD_LOCKS.clear()
        _FEED_BUILD_LOCKS_LAST_USED.clear()


def _fetch_feed(game_pk: str = GAME_PK) -> dict:
    """Return the latest parsed MLB live feed for a game, cached briefly.

    Fetches + parses the MLB live feed with a timeout, raising a clean 502 on a
    network error/timeout or a non-200 response instead of leaking a raw
    traceback (which FastAPI would surface as an opaque 500). Serves a cached
    copy to concurrent polls within ``FEED_CACHE_TTL_SECONDS`` so they don't
    each hammer statsapi.mlb.com, single-flighting a cold/missed fetch so only
    one request is issued per game at a time.
    """
    # Opportunistically bound the per-game feed locks / expired feed entries.
    _prune_feed_build_locks()
    now = time.monotonic()
    with _FEED_CACHE_GUARD:
        entry = _FEED_CACHE.get(game_pk)
        if entry and now - entry["fetched_at"] < FEED_CACHE_TTL_SECONDS:
            return entry["data"]

    build_lock = _cache_build_lock(
        _FEED_BUILD_LOCKS, _FEED_CACHE_GUARD, game_pk, _FEED_BUILD_LOCKS_LAST_USED
    )
    with build_lock:
        # Re-check after winning the single-flight lock: the leader may have
        # populated the cache while we waited on a concurrent cold fetch.
        now = time.monotonic()
        with _FEED_CACHE_GUARD:
            entry = _FEED_CACHE.get(game_pk)
            if entry and now - entry["fetched_at"] < FEED_CACHE_TTL_SECONDS:
                return entry["data"]
        try:
            response = requests.get(_feed_url(game_pk), timeout=MLB_FEED_TIMEOUT_SECONDS)
        except requests.RequestException:
            raise HTTPException(status_code=502, detail="Failed to fetch from MLB API (network error or timeout)")
        if response.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch from MLB API")
        data = response.json()
        with _FEED_CACHE_GUARD:
            _FEED_CACHE[game_pk] = {"data": data, "fetched_at": time.monotonic()}
        return data

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
# ``time.monotonic()`` of the last time each trajectory build lock was touched,
# used by the LRU-style eviction in ``_prune_build_locks``.
_TRAJECTORY_BUILD_LOCKS_LAST_USED: dict[tuple[str, str, str], float] = {}
_BATTED_BALL_CACHE: dict[tuple[str, str], dict] = {}
_BATTED_BALL_CACHE_GUARD = threading.RLock()
_BATTED_BALL_BUILD_LOCKS: dict[tuple[str, str], threading.Lock] = {}
_BATTED_BALL_BUILD_LOCKS_LAST_USED: dict[tuple[str, str], float] = {}
# Cursor-specific responses are useful for a short catch-up window, but keeping
# every cursor seen during a long game would make the in-memory cache grow once
# per applied pitch/hit. Keep a bounded LRU-like window per game/environment.
# The same window caps the per-key single-flight build locks (mirroring
# ``_prune_feed_build_locks``) so a long session polling many games/cursors
# doesn't accumulate a lock entry per distinct cursor forever.
_TRAJECTORY_CURSOR_CACHE_MAX_ENTRIES = 16
_BATTED_BALL_CURSOR_CACHE_MAX_ENTRIES = 16
_TRAJECTORY_BUILD_LOCKS_MAX_ENTRIES = 16
_BATTED_BALL_BUILD_LOCKS_MAX_ENTRIES = 16


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


def _cache_build_lock(
    lock_map: dict,
    guard: threading.RLock,
    key,
    last_used_map: dict | None = None,
):
    """Return the single-flight lock for one cache key.

    When ``last_used_map`` is provided, the key's access time is recorded under
    the guard so ``_prune_build_locks`` can evict least-recently-used entries.
    """
    with guard:
        lock = lock_map.get(key)
        if lock is None:
            lock = threading.Lock()
            lock_map[key] = lock
        if last_used_map is not None:
            last_used_map[key] = time.monotonic()
        return lock


def _prune_build_locks(
    lock_map: dict,
    last_used_map: dict,
    guard: threading.RLock,
    scope: tuple,
    max_entries: int,
) -> None:
    """Bound the single-flight build locks within one cache scope (LRU).

    Mirrors ``_prune_cursor_cache_entries``: the response caches already cap
    stale cursor entries per game/environment, but each of those cursor keys
    also registered a single-flight build lock that otherwise lived forever.
    Once a scope (e.g. ``(game_pk, env)`` for trajectory, ``(game_pk,)`` for
    batted-ball) holds more than ``max_entries`` locks, the least-recently-used
    idle locks are evicted. A lock currently held (an in-flight simulation) is
    never evicted, so a later request just lazily recreates it — at worst
    costing one extra rebuild. The caller holds ``guard`` (an RLock, so nested
    acquisition is fine) and may itself be holding the lock for this request's
    key, which ``lock.locked()`` protects.
    """
    if max_entries < 1 or not isinstance(scope, tuple):
        return
    with guard:
        scoped = [
            key
            for key in lock_map
            if (
                isinstance(key, tuple)
                and len(key) == len(scope) + 1
                and key[:len(scope)] == scope
            )
        ]
        excess = len(scoped) - max_entries
        if excess <= 0:
            return
        scoped.sort(key=lambda key: (last_used_map.get(key, 0.0), str(key)))
        for key in scoped:
            if excess <= 0:
                break
            lock = lock_map.get(key)
            if lock is None or lock.locked():
                # In-flight build; skip it and try another, leaving the window
                # slightly over cap until the build finishes and releases.
                continue
            lock_map.pop(key, None)
            last_used_map.pop(key, None)
            excess -= 1


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
    all_plays = data.get('liveData', {}).get('plays', {}).get('allPlays') or []
    newest_play = all_plays[-1] if all_plays else None
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
        # A no-pitch play appended after the last simulatable pitch (an
        # automatic intentional walk) changes the pending_play_event surfaced
        # in the response, so it must invalidate the cache too.
        "newest_play_result": newest_play.get('result') if newest_play else None,
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
# wild pitch / passed ball / stolen base / caught stealing / pickoff attempt /
# balk is emitted as an action event immediately after the pitch it happened on,
# so the frontend can surface it instead of a bare BALL/STRIKE. Keys are the
# feed's ``eventType`` values.
_ACTION_EVENT_LABELS = {
    'wild_pitch': 'Wild Pitch',
    'passed_ball': 'Passed Ball',
    'balk': 'Balk',
    'stolen_base_2b': 'Stolen Base 2B',
    'stolen_base_3b': 'Stolen Base 3B',
    'stolen_base_home': 'Stolen Base Home',
    'caught_stealing_2b': 'Caught Stealing 2B',
    'caught_stealing_3b': 'Caught Stealing 3B',
    'caught_stealing_home': 'Caught Stealing Home',
    'pickoff_attempt_1b': 'Pickoff Attempt 1B',
    'pickoff_attempt_2b': 'Pickoff Attempt 2B',
    'pickoff_attempt_3b': 'Pickoff Attempt 3B',
    'pickoff_attempt_home': 'Pickoff Attempt Home',
}

# Plays that can end with no pitch event at all (an automatic intentional walk
# has no thrown pitches, and some pickoff attempts are recorded as standalone
# plays). Their result still deserves a banner, so the trajectory endpoint
# surfaces it via ``pending_play_event`` when the feed has moved past the last
# simulatable pitch into one of these.
_NON_PITCH_OUTCOME_EVENTS = {
    'Intent Walk',
    'Balk',
    'Pickoff Attempt 1B',
    'Pickoff Attempt 2B',
    'Pickoff Attempt 3B',
    'Caught Stealing 2B',
    'Caught Stealing 3B',
    'Caught Stealing Home',
    'Stolen Base 2B',
    'Stolen Base 3B',
    'Stolen Base Home',
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
_savant_rows_building: set[str] = set()
_savant_rows_next_attempt: dict[str, float] = {}
# ``time.monotonic()`` of the last access to each game's rows, kept parallel to
# ``_savant_rows_cache`` so ``_prune_savant_rows_cache`` can evict
# least-recently-used entries.
_savant_rows_cache_last_used: dict[str, float] = {}
_savant_rows_lock = threading.Lock()
_SAVANT_ROWS_REBUILD_COOLDOWN_SECONDS = 60
# Cap on distinct games whose parsed Statcast CSV stays resident. Each entry is
# the full per-pitch CSV for one game (thousands of rows), so it's bounded more
# tightly than the lock/cursor windows: a live frontend tracks only a handful of
# games at once, and evicted games are re-scraped lazily on their next visit.
_SAVANT_ROWS_CACHE_MAX_ENTRIES = 32


def _prune_savant_rows_cache() -> None:
    """Bound the per-game Savant CSV rows cache with an LRU-style window.

    Each entry holds the full parsed Statcast CSV for a game, so a long session
    touching many games would otherwise grow it (and the process's memory)
    without bound. Once ``_savant_rows_cache`` passes
    ``_SAVANT_ROWS_CACHE_MAX_ENTRIES`` the least-recently-used games that are
    NOT mid-fetch are evicted, dropping their rows, their parallel ``next_attempt``
    backoff entry, and their last-used stamp. A game whose rebuild thread is
    still running is never evicted (its ``building`` flag stays set and we skip
    it), so a later poll doesn't re-scrape mid-build.

    Caller must not hold ``_savant_rows_lock``; it is acquired here.
    """
    max_entries = _SAVANT_ROWS_CACHE_MAX_ENTRIES
    if max_entries < 1:
        return
    with _savant_rows_lock:
        excess = len(_savant_rows_cache) - max_entries
        if excess <= 0:
            return
        candidates = sorted(
            (g for g in _savant_rows_cache if g in _savant_rows_cache_last_used),
            key=lambda g: _savant_rows_cache_last_used[g],
        )
        for game in candidates:
            if excess <= 0:
                break
            if game in _savant_rows_building:
                # A rebuild is in flight for this game; keep its rows and flag so
                # the fetch can land and the rows stay cachable.
                continue
            _savant_rows_cache.pop(game, None)
            _savant_rows_next_attempt.pop(game, None)
            _savant_rows_cache_last_used.pop(game, None)
            excess -= 1


def _fetch_savant_rows(game_pk: str, game_date: str | None) -> list[dict]:
    """Per-pitch Statcast search CSV rows for a game, fetched in the background.

    Savant's ``statcast_search`` endpoint has no ``game_pk`` filter, so the
    rows are fetched for a window around the game's official date (exclusive
    bounds, widened by two days to absorb timezone drift) and filtered to this
    game's ``game_pk`` column.

    The fetch runs in a background daemon thread so a cold trajectory build is
    not blocked on the (up to 15s) Savant round-trip — the same treatment as
    the xBA grid and sprint-speed map. It is single-flighted (at most one
    in-flight request per game) and a failed/empty fetch backs off for
    ``_SAVANT_ROWS_REBUILD_COOLDOWN_SECONDS`` so a down Savant can't spawn a
    fresh scrape on every poll. Until a successful fetch lands, callers get
    the current (possibly empty) rows and fall back to a neutral swing plane /
    live formation, so the trajectory endpoint never waits on Savant; the row
    values (``swing_path_tilt``, ``attack_angle``, formation) enrich the next
    rebuilt payloads once the fetch completes.
    """
    _prune_savant_rows_cache()
    key = str(game_pk)
    now_mono = time.monotonic()
    if key in _savant_rows_cache:
        with _savant_rows_lock:
            _savant_rows_cache_last_used[key] = now_mono
        return _savant_rows_cache[key]
    game_day = None
    if game_date:
        try:
            game_day = datetime.strptime(game_date, '%Y-%m-%d')
        except ValueError:
            game_day = None
    if game_day is None:
        with _savant_rows_lock:
            _savant_rows_cache[key] = []
            _savant_rows_cache_last_used[key] = now_mono
        return []

    now = time.time()
    with _savant_rows_lock:
        if key in _savant_rows_cache:
            _savant_rows_cache_last_used[key] = now_mono
            return _savant_rows_cache[key]
        if key in _savant_rows_building or now < _savant_rows_next_attempt.get(key, 0.0):
            _savant_rows_cache_last_used[key] = now_mono
            return _savant_rows_cache.get(key, [])
        _savant_rows_building.add(key)
        _savant_rows_cache_last_used[key] = now_mono

    def _rebuild():
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
                row for row in csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig")))
                if row.get('game_pk') == key
            ]
            # Only cache successful, non-empty fetches: games Savant has not
            # ingested yet return empty, and caching that would keep the
            # trajectory null forever even after the data arrives.
            if rows:
                with _savant_rows_lock:
                    _savant_rows_cache[key] = rows
                    _savant_rows_cache_last_used[key] = time.monotonic()
                    _savant_rows_next_attempt.pop(key, None)
                    _savant_rows_building.discard(key)
                _prune_savant_rows_cache()
                print(f"[savant-rows] loaded {len(rows):,} rows for game {key}")
            else:
                raise ValueError("no statcast rows for game")
        except Exception:
            # Back off before the next attempt so rapid polls can't each
            # re-spawn a scrape while Savant is down / hasn't ingested the game.
            with _savant_rows_lock:
                _savant_rows_next_attempt[key] = (
                    time.time() + _SAVANT_ROWS_REBUILD_COOLDOWN_SECONDS
                )
                _savant_rows_cache_last_used[key] = time.monotonic()
        finally:
            with _savant_rows_lock:
                _savant_rows_building.discard(key)

    threading.Thread(target=_rebuild, daemon=True).start()
    return _savant_rows_cache.get(key, [])


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


def _combine_fielding_alignment(infield: str, outfield: str) -> str:
    """Combine Statcast infield/outfield alignment labels into one panel label.

    The frontend DefenseDiagram understands Standard / Strategic / Infield In.
    Savant labels infield alignments as Standard, Infield In, Strategic,
    Infield Shift (and occasionally "Infield shade" for a mild pull shade), and
    outfield alignments as Standard, Strategic or 4th Outfielder. The infield
    label drives the diagram; a shift/shade or a non-standard outfield
    alignment reads as Strategic.
    """
    if infield == 'Infield In':
        return 'Infield In'
    if infield in ('Strategic', 'Infield Shift', 'Infield shade'):
        return 'Strategic'
    if outfield in ('Strategic', '4th Outfielder'):
        return 'Strategic'
    return 'Standard'


def _formation_for_pitch(game_pk: str, game_date: str | None,
                         play: dict, pitch_event: dict) -> str | None:
    """Look up the defensive formation in effect for one historical pitch.

    The statsapi feed only carries the CURRENT formation (``linescore.defense.
    defensiveAlignment``, when present at all), so a replayed at-bat would
    otherwise keep showing today's formation. The per-pitch historical
    formation (infield in / strategic / shift) lives in Savant's Statcast rows,
    which the bat-tracking lookup above already fetches for this game — match
    the same row by batter + at-bat + pitch number. Returns None when the row
    is unavailable, so callers fall back to the live formation.
    """
    batter_id = (play.get('matchup') or {}).get('batter', {}).get('id')
    at_bat_index = (play.get('about') or {}).get('atBatIndex')
    pitch_number = pitch_event.get('pitchNumber')
    if batter_id is None or at_bat_index is None or pitch_number is None:
        return None
    target_at_bat = str(int(at_bat_index) + 1)
    for row in _fetch_savant_rows(game_pk, game_date):
        if (row.get('batter') == str(batter_id)
                and row.get('at_bat_number') == target_at_bat
                and row.get('pitch_number') == str(pitch_number)):
            return _combine_fielding_alignment(
                (row.get('if_fielding_alignment') or '').strip(),
                (row.get('of_fielding_alignment') or '').strip(),
            )
    return None


def _live_formation_from_savant(game_pk: str, game_date: str | None,
                                all_plays: list | None) -> str | None:
    """Return the defensive formation for the newest pitch Statcast knows.

    The statsapi feed stopped carrying a per-pitch defensive alignment (the
    live feed's ``linescore.defense.defensiveAlignment`` is absent in the
    current API, so ``_defense_snapshot`` always reports Standard), while
    Statcast still tracks the real infield-in / strategic setup per pitch.

    The live ``/api/game-state`` and ``/api/game-status`` formation should
    therefore come from Statcast, not the effectively-dead linescore field.
    Walk the play log newest-pitch-first and return the alignment of the
    latest pitch Savant has ingested (reusing the same batter + at-bat +
    pitch-number match as the trajectory snapshot's historical ``_formation_for_pitch``)
    so the frontend's live DefenseDiagram reflects the team's actual setup.
    Returns None when Savant has no data for the game yet, so callers fall
    back to the live linescore label.
    """
    if not all_plays:
        return None
    for play in reversed(all_plays):
        for ev in reversed(play.get('playEvents') or []):
            if not ev.get('isPitch') or not ev.get('pitchNumber'):
                continue
            formation = _formation_for_pitch(game_pk, game_date, play, ev)
            if formation is not None:
                return formation
    return None


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


def _induced_breaks_inches(pitch_data: dict):
    """Return (h_break, ivb) in inches for a pitch event, matching Baseball
    Savant's game feed (and the Savant CSV pfx_x/pfx_z, feet converted).

    The live feed carries three different movement representations; Savant's
    game feed displays the ``breaks`` object:
      * IVB      = breaks.breakVerticalInduced
      * H Break  = -breaks.breakHorizontal   (breakHorizontal is sign-flipped:
        positive = toward 3B / catcher's left, so negating restores the
        conventional positive = toward 1B / catcher's right)
    ``coordinates.pfxX/pfxZ`` are a separate, smaller-magnitude raw
    measurement that does NOT match Savant, so they only backfill payloads
    whose ``breaks`` object lacks the induced-break fields (e.g. some
    historical or cached feeds). Returns (None, None) when neither source has
    a value. Nothing here comes from the physics simulation.
    """
    coordinates = pitch_data.get('coordinates') or {}
    breaks = pitch_data.get('breaks') or {}

    pfx_ivb = breaks.get('breakVerticalInduced')
    pfx_h = breaks.get('breakHorizontal')
    if pfx_ivb is None and coordinates.get('pfxZ') is not None:
        pfx_ivb = float(coordinates['pfxZ'])
    if pfx_h is None and coordinates.get('pfxX') is not None:
        pfx_h = -float(coordinates['pfxX'])

    pfx_z = float(pfx_ivb) if pfx_ivb is not None else None
    pfx_x = -float(pfx_h) if pfx_h is not None else None
    return pfx_x, pfx_z


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
    # Whether this pitch is the at-bat's final pitch — the one that produced the
    # play's resolved result. Non-final pitches still carry the at-bat's final
    # ``result_event`` (e.g. "Strikeout"), so the frontend uses this flag to fall
    # back to the pitch's own BALL/STRIKE/FOUL instead of surfacing the final
    # outcome early when it drains a queue of catch-up plays.
    final_pitch_number = max(
        (event.get('pitchNumber') for event in play.get('playEvents', [])
         if event.get('isPitch') and event.get('pitchNumber') is not None),
        default=None,
    )
    is_at_bat_final = (
        final_pitch_number is not None
        and pitch_event.get('pitchNumber') == final_pitch_number
    )
    # If the latest pitch got away from the catcher, the feed records that as
    # an action event right after the pitch event (the pitch's own details only
    # carry the ball/strike call). Surface it so the frontend can show WILD
    # PITCH / PASSED BALL when that pitch is the one being animated.
    action_event = None
    action_event_runner = None
    if pitch_index is not None:
        events = play.get('playEvents', [])
        if pitch_index + 1 < len(events):
            nxt = events[pitch_index + 1]
            details = nxt.get('details') or {}
            if not nxt.get('isPitch'):
                et = details.get('eventType')
                if et in _ACTION_EVENT_LABELS:
                    action_event = details.get('event') or _ACTION_EVENT_LABELS[et]
                    # Extract the runner's name from the description so the
                    # frontend can show e.g. "Ronald Acuña Jr. steals 2nd base"
                    desc = details.get('description') or ''
                    for sep in (' steals ', ' caught stealing ', ' caught '):
                        if sep in desc:
                            action_event_runner = desc.split(sep)[0].strip()
                            break
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

    # Induced break values (inches) matching Baseball Savant's game feed — see
    # _induced_breaks_inches for the source-of-truth rules.
    pfx_x_payload, pfx_z_payload = _induced_breaks_inches(pitch_data)

    return {
        "success": True,
        "play_id": play_id,
        "at_bat_index": play.get('about', {}).get('atBatIndex'),
        "play_complete": bool((play.get('about') or {}).get('isComplete')),
        "pitcher": pitcher,
        "pitcher_id": pitcher_id,
        "batter": batter,
        "batter_id": batter_id,
        "bat_side": bat_side,
        "pitch_hand": pitch_hand,
        "is_top_inning": is_top_inning,
        "swing": swing,
        "call_code": call_code,
        "is_contact": is_contact,
        "result_event": result_event,
        "is_at_bat_final": is_at_bat_final,
        "action_event": action_event,
        "action_event_runner": action_event_runner,
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
        # Statcast induced break (inches) for the pitch panel's H Break / IVB
        # rows — the same values Baseball Savant's game feed displays. The feed
        # carries three different movement representations; Savant uses the
        # ``breaks`` object:
        #   * IVB      = breaks.breakVerticalInduced
        #   * H Break  = -breaks.breakHorizontal  (the feed's breakHorizontal
        #     is sign-flipped: positive = toward 3B / catcher's left)
        # ``coordinates.pfxX/pfxZ`` are a separate raw measurement with a
        # different (smaller) magnitude and do NOT match Savant, so they are
        # only a fallback for payloads whose ``breaks`` object lacks the
        # induced-break fields. Nothing here comes from the physics simulation.
        "pfx_x": pfx_x_payload,
        "pfx_z": pfx_z_payload,
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
        "game_state": _game_state_snapshot(
            data, play, pitch_event, pitch_index, game_pk=game_pk, game_date=game_date,
        ),
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
    data = _fetch_feed(game_pk)
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
            _TRAJECTORY_BUILD_LOCKS,
            _TRAJECTORY_CACHE_GUARD,
            cache_key,
            _TRAJECTORY_BUILD_LOCKS_LAST_USED,
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
                    _prune_build_locks(
                        _TRAJECTORY_BUILD_LOCKS,
                        _TRAJECTORY_BUILD_LOCKS_LAST_USED,
                        _TRAJECTORY_CACHE_GUARD,
                        cache_key[:-1],
                        _TRAJECTORY_BUILD_LOCKS_MAX_ENTRIES,
                    )
            if cached and cached["source_key"] == source_key:
                print(f"TRAJECTORY CACHE HIT... game {game_pk} (env={cache_env})")
                # Recompute xBA from the cached launch data so a freshly-built
                # grid feeds through without invalidating the entire cache.
                response = cached["response"]
                _refresh_xba_in_place(response)
                return response

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

            # If the feed has advanced past the newest simulatable pitch into a
            # play with no pitch event (an automatic intentional walk, a
            # standalone pickoff attempt), surface that play's result so the
            # frontend can show a banner even though there is nothing to
            # animate.
            all_plays = data.get('liveData', {}).get('plays', {}).get('allPlays') or []
            newest_play = all_plays[-1] if all_plays else None
            pending_play_event = None
            if newest_play is not None:
                newest_event = (newest_play.get('result') or {}).get('event')
                has_simulatable_pitch = any(
                    event.get('isPitch') and _pitch_is_simulatable(event)
                    for event in newest_play.get('playEvents', [])
                )
                if not has_simulatable_pitch and newest_event in _NON_PITCH_OUTCOME_EVENTS:
                    pending_play_event = newest_event
            payload["pending_play_event"] = pending_play_event
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
                _prune_build_locks(
                    _TRAJECTORY_BUILD_LOCKS,
                    _TRAJECTORY_BUILD_LOCKS_LAST_USED,
                    _TRAJECTORY_CACHE_GUARD,
                    cache_key[:-1],
                    _TRAJECTORY_BUILD_LOCKS_MAX_ENTRIES,
                )
            return payload
    except HTTPException:
        raise
    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Simulation failed: {e}")


@app.get("/api/trajectory/prewarm")
def prewarm_trajectory(game_pk: str = GAME_PK):
    """Kick off a background trajectory build for a game, fire-and-forget.

    The frontend calls this when it switches to a game so the first real poll
    hits a warm cache instead of a cold rebuild. The build reuses the normal
    trajectory logic (``get_trajectory``), so it shares ``get_trajectory``'s
    build-cache, its single-flight build lock, and ``_fetch_feed``'s cache: a
    concurrent poll never duplicates the work, an already-warm game is a no-op,
    and an in-flight prewarm simply blocks the first poll on the shared lock
    until the warm payload is cached. Failures are swallowed here — the next
    real poll surfaces them normally.

    Returns immediately with whether the game was already warm at call time.
    """
    game_pk = str(game_pk)
    warm = False
    with _TRAJECTORY_CACHE_GUARD:
        cached = _TRAJECTORY_CACHE.get((game_pk, "live", ""))
        warm = bool(cached)

    if not warm:
        def _prewarm():
            try:
                # after_play_id defaults to None, matching the very first poll
                # a switching client makes (its cursor is reset to null).
                get_trajectory(env="live", game_pk=game_pk)
            except Exception:
                # Best-effort: the client's next real poll surfaces any error.
                pass

        threading.Thread(target=_prewarm, daemon=True).start()
    return {"success": True, "game_pk": game_pk, "warm": warm}


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
    data = _fetch_feed(game_pk)
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

# Mapping from MLB result event to scorebug summary label.
_EVENT_SUMMARY_LABEL = {
    "Single": "1B",
    "Double": "2B",
    "Triple": "3B",
    "Home Run": "HR",
    "Walk": "BB",
    "Intent Walk": "BB",
    "Hit By Pitch": "HBP",
    "Strikeout": "SO",
    "Sac Fly": "SAC",
    "Sac Bunt": "SAC",
    "Groundout": "GO",
    "Forceout": "GO",
    "Bunt Groundout": "GO",
    "Flyout": "FO",
    "Pop Out": "FO",
    "Lineout": "FO",
    "Double Play": "DP",
    "Triple Play": "DP",
    "Grounded Into DP": "DP",
}

# Ordered list of summary labels for display priority (left to right).
_SUMMARY_DISPLAY_ORDER = ["1B", "2B", "3B", "HR", "BB", "HBP", "SO", "RBI", "SAC", "GO", "FO", "DP"]


def _batter_play_summary(batter_id: int, plays: list) -> dict:
    """Count each outcome type and total RBI for a batter across the given plays.

    Returns a dict like {'1B': 2, 'HR': 1, 'BB': 1, 'RBI': 3, 'SO': 1} — only
    keys with non-zero values are included. Keys follow the display order in
    _SUMMARY_DISPLAY_ORDER.
    """
    counts: dict[str, int] = {}
    for play in plays:
        if play.get('matchup', {}).get('batter', {}).get('id') != batter_id:
            continue
        result = play.get('result', {})
        if result.get('type') != 'atBat':
            continue
        event = result.get('event') or ''
        label = _EVENT_SUMMARY_LABEL.get(event)
        if label:
            counts[label] = counts.get(label, 0) + 1
        rbi = result.get('rbi')
        if isinstance(rbi, (int, float)) and rbi > 0:
            counts['RBI'] = counts.get('RBI', 0) + int(rbi)
    # Return only non-zero, in display order.
    return {k: counts[k] for k in _SUMMARY_DISPLAY_ORDER if k in counts and counts[k] > 0}


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
    # Name of the fielder who fields this ball, so the fielder-cam's top-left
    # pill (and any defense-facing label) can show the player instead of '—'.
    # Recover the defensive alignment in effect at this hit's moment (handles a
    # historical at-bat replay and half-inning changes) and fall back to the
    # live alignment; None when the name can't be resolved.
    fielder_name = None
    alignment = None
    try:
        prefix = _prefix_through_pitch(data, batted_play, hit_event_index)
        alignment, _ = _historical_defense_snapshot(data, prefix)
    except Exception:
        alignment = None
    if not alignment:
        alignment, _ = _defense_snapshot(
            (data.get('liveData') or {}).get('linescore') or {}
        )
    fielder_name = ((alignment or {}).get(fielder) or {}).get('name') or None

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
    #
    # Look up player names from the boxscore for each credit so the frontend
    # can display "SS Bo Bichette to 2B Cavan Biggio to 1B Vladdy Jr."
    box_players = (data.get('liveData', {}).get('boxscore', {}).get('teams', {}) or {})
    def _credit_player_name(player_id) -> str | None:
        if not player_id:
            return None
        for side in ('away', 'home'):
            players = (box_players.get(side) or {}).get('players') or {}
            entry = players.get(f'ID{player_id}') or players.get(str(player_id))
            if entry:
                return (entry.get('person') or {}).get('fullName')
        return None
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
                    "player": _credit_player_name((c.get('player') or {}).get('id')),
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
        "batter_id": (matchup.get('batter') or {}).get('id'),
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
        # Both spellings: the frontend's normalizer prefers ``fielder_name`` but
        # falls back to ``fielderName`` for older payloads.
        "fielder_name": fielder_name,
        "fielderName": fielder_name,
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
    data = _fetch_feed(game_pk)
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
            _BATTED_BALL_BUILD_LOCKS,
            _BATTED_BALL_CACHE_GUARD,
            cache_key,
            _BATTED_BALL_BUILD_LOCKS_LAST_USED,
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
                    _prune_build_locks(
                        _BATTED_BALL_BUILD_LOCKS,
                        _BATTED_BALL_BUILD_LOCKS_LAST_USED,
                        _BATTED_BALL_CACHE_GUARD,
                        cache_key[:-1],
                        _BATTED_BALL_BUILD_LOCKS_MAX_ENTRIES,
                    )
            if cached and cached["source_key"] == source_key:
                print(f"BATTED BALL CACHE HIT... game {game_pk}")
                response = cached["response"]
                _refresh_xba_in_place(response)
                return response

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
                _prune_build_locks(
                    _BATTED_BALL_BUILD_LOCKS,
                    _BATTED_BALL_BUILD_LOCKS_LAST_USED,
                    _BATTED_BALL_CACHE_GUARD,
                    cache_key[:-1],
                    _BATTED_BALL_BUILD_LOCKS_MAX_ENTRIES,
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


def _game_state_before_pitch(data: dict, play: dict, pitch_event: dict,
                             pitch_index: int, game_pk: str = GAME_PK) -> dict:
    """Build the replay scoreboard state immediately before one pitch.

    The truncated play copy keeps the at-bat's own result and runner movement
    out of the state: before the pitch is thrown, none of the at-bat's runs or
    base changes have happened yet, and the scoreboard must show the game as
    it stood before the pitch, not the feed's final score/bases.
    """
    about = {**(play.get('about') or {}), 'isComplete': False}
    before_play = {
        **play,
        'about': about,
        'result': {},
        'runners': [],
        'playEvents': (play.get('playEvents') or [])[:pitch_index],
    }
    # _prefix_through_pitch matches plays by object identity, so the truncated
    # copy would never be found and the whole (already-complete) feed would be
    # included. Build the prefix explicitly: every play before this at-bat,
    # then this at-bat with only the events thrown before the target pitch.
    all_plays = (data.get('liveData') or {}).get('plays', {}).get('allPlays') or []
    prefix = []
    for existing in all_plays:
        if existing is play:
            prefix.append(before_play)
            break
        prefix.append(existing)
    return _game_state_snapshot(
        data, before_play, pitch_event, None, prefix=prefix, game_pk=game_pk,
    )


@app.get("/api/at-bat")
def get_at_bat(at_bat_index: Optional[int] = None, game_pk: str = GAME_PK):
    """
    Return every pitch thrown in one at-bat, with its strike-zone location,
    tunneling color classification, and (for replayable pitches) the full
    trajectory + batted-ball payloads so the frontend can replay any of them.
    """
    print(f"AT-BAT... Polling game {game_pk} (at_bat_index={at_bat_index})")
    data = _fetch_feed(game_pk)
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
                pitch_payload['game_state_before'] = _game_state_before_pitch(
                    data, play, event, idx, game_pk=game_pk,
                )

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


@app.get("/api/batter-pitches")
def get_batter_pitches(at_bat_index: Optional[int] = None, game_pk: str = GAME_PK):
    """
    Return every pitch thrown to the current at-bat's batter across the whole
    game, grouped by the pitcher who threw it. Powers the at-bat panel's game
    view (all pitches the batter has faced), with a per-pitcher list so the
    frontend can filter the strike zone by pitcher.

    Unlike /api/at-bat this stays lightweight: pitches carry their location,
    outcome, and pitch type for the strike-zone dots, but no full trajectory
    payloads (the game view disables click-to-replay).
    """
    print(f"BATTER-PITCHES... Polling game {game_pk} (at_bat_index={at_bat_index})")
    data = _fetch_feed(game_pk)
    try:
        all_plays = data['liveData']['plays']['allPlays']
        if not all_plays:
            raise HTTPException(status_code=404, detail="Game hasn't started yet!")

        # Default to the at-bat of the newest play that contains a pitch, so the
        # view opens on the batter currently at the plate.
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

        batter_id = (play.get('matchup') or {}).get('batter', {}).get('id')
        batter_name = (play.get('matchup') or {}).get('batter', {}).get('fullName', 'N/A')
        if batter_id is None:
            raise HTTPException(status_code=404, detail="No batter found for this at-bat.")

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

        pitches = []
        pitchers = []
        pitcher_order = {}
        for pl in all_plays:
            if (pl.get('matchup') or {}).get('batter', {}).get('id') != batter_id:
                continue
            ab_index = (pl.get('about') or {}).get('atBatIndex')
            pitcher_info = (pl.get('matchup') or {}).get('pitcher', {})
            pitcher_id = pitcher_info.get('id')
            pitcher_name = pitcher_info.get('fullName', 'N/A')
            # Key on id when available (names can collide across teams); fall
            # back to the name so a missing id never merges or drops pitches.
            pitcher_key = pitcher_id if pitcher_id is not None else f"name:{pitcher_name}"
            if pitcher_key not in pitcher_order:
                pitcher_order[pitcher_key] = len(pitchers)
                pitchers.append({
                    "pitcher_id": pitcher_id,
                    "pitcher": pitcher_name,
                    "pitches": 0,
                })
            pitcher_slot = pitcher_order[pitcher_key]

            final_pitch_number = max(
                (e.get('pitchNumber') for e in pl.get('playEvents', [])
                 if e.get('isPitch') and e.get('pitchNumber') is not None),
                default=None,
            )
            for event in pl.get('playEvents', []):
                if not event.get('isPitch'):
                    continue
                pitch_number = event.get('pitchNumber')
                details = event.get('details') or {}
                pitch_type = (details.get('type') or {}).get('code')
                coords = (event.get('pitchData') or {}).get('coordinates') or {}
                outcome, outs, call_code, result_event = _classify_pitch_outcome(event, pl)
                pitchers[pitcher_slot]["pitches"] += 1
                pitches.append({
                    "pitch_number": pitch_number,
                    "at_bat_index": ab_index,
                    "play_id": f"AB{ab_index}-P{pitch_number}",
                    "pitcher_id": pitcher_id,
                    "pitcher": pitcher_name,
                    "pitch_type": pitch_type,
                    "pitch_type_description": (details.get('type') or {}).get('description'),
                    "speed_mph": (event.get('pitchData') or {}).get('startSpeed'),
                    "call_code": call_code,
                    "result_event": result_event,
                    "description": details.get('description'),
                    "outcome": outcome,
                    "outs": outs,
                    "is_at_bat_final": (final_pitch_number is not None and pitch_number == final_pitch_number),
                    "statcast_px": coords.get('pX'),
                    "statcast_pz": coords.get('pZ'),
                    "replayable": _pitch_is_simulatable(event),
                })

        return {
            "success": True,
            "at_bat_index": at_bat_index,
            "batter": batter_name,
            "batter_id": batter_id,
            "strike_zone_top": sz_top,
            "strike_zone_bottom": sz_bottom,
            "pitchers": pitchers,
            "pitches": pitches,
        }
    except HTTPException:
        raise
    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Batter pitches parsing failed: {e}")


def _occupied_bases(all_plays: list, game_type: str = None) -> list:
    """Return the bases currently occupied ('1B'/'2B'/'3B'), sorted.

    The feed's ``runners`` list only includes runners who moved, scored, or were
    put out during a play, so stationary runners must be carried forward. This
    replays the runner movements of the current half-inning from its start.

    Two feed quirks make naive base accounting wrong: a runner can appear twice
    in one play (e.g. a wild pitch then a sacrifice fly), and the runners are
    listed in feed order, so a batter reaching first can be listed before the
    runner who vacated first. Each runner's legs are therefore collapsed into a
    single departure/arrival, and all departures are applied before arrivals.

    Extra-innings ghost runner (regular-season rule): each extra half-inning
    starts with an automatic runner on second. The feed does not model this
    runner as a persistent base occupant — the placement is implicit in the
    half-inning start — so a naive replay of runner movements sees an empty
    diamond even while a runner is standing on second. Seed the replay with
    the ghost runner when ``game_type`` is "R" (regular season; postseason
    game types start extra innings empty). When ``game_type`` is unknown the
    seed still applies — the common case is regular season, and postseason
    feeds always carry ``gameData.game.type`` so they are never ambiguous.
    """
    if not all_plays:
        return []
    last_about = all_plays[-1].get('about') or {}
    inning = last_about.get('inning')
    half = last_about.get('halfInning')
    bases = set()
    ghost_active = False
    if inning is not None and inning > 9 and half in ('top', 'bottom') \
            and (game_type is None or game_type == 'R'):
        bases.add('2B')
        ghost_active = True
    ghost_accounted = False
    for play in all_plays:
        about = play.get('about') or {}
        if about.get('inning') != inning or about.get('halfInning') != half:
            continue
        first_start_by_runner = {}
        last_leg_by_runner = {}
        is_batter_by_runner = {}
        anon = 0
        matchup = play.get('matchup') or {}
        batter_info = matchup.get('batter') or {}
        batter_id = batter_info.get('id')
        batter_name = batter_info.get('fullName')

        runners_list = play.get('runners') or []
        for runner in runners_list:
            mv = runner.get('movement') or {}
            details = runner.get('details') or {}
            r_info = details.get('runner') or {}
            rid = r_info.get('id')
            if rid is None:
                rid = ('anon', anon)
                anon += 1
            if rid not in first_start_by_runner:
                first_start_by_runner[rid] = mv.get('start')
            last_leg_by_runner[rid] = (mv.get('end'), bool(mv.get('isOut')))

            # Check if this runner is the batter. The batter always starts at
            # home plate (start=None), but must never be mistaken for the
            # extra-innings ghost runner seeded at 2B.
            is_b = bool(details.get('isBatter'))
            if not is_b and batter_id is not None and rid == batter_id:
                is_b = True
            if not is_b and batter_name and r_info.get('fullName') == batter_name:
                is_b = True
            if not is_b and mv.get('start') is None and len(runners_list) == 1:
                is_b = True
            is_batter_by_runner[rid] = is_b

        departures = set()
        arrivals = set()
        for rid, first_start in first_start_by_runner.items():
            if first_start in ('1B', '2B', '3B'):
                departures.add(first_start)
                if first_start == '2B':
                    ghost_accounted = True
            end, is_out = last_leg_by_runner[rid]
            if not is_out and end in ('1B', '2B', '3B'):
                arrivals.add(end)
            elif (
                ghost_active
                and not ghost_accounted
                and not is_batter_by_runner.get(rid, False)
                and first_start is None
                and (is_out or end == 'score')
            ):
                # Ghost runner resolved: the feed lists the automatic runner
                # with no start base (it was never placed by a play). A
                # null-start runner that is NOT the batter and that scores or
                # is put out can only be the ghost — vacate the seeded 2B.
                # Only the first such runner per half-inning counts.
                departures.add('2B')
                ghost_accounted = True
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


# Maps the feed's linescore.defense keys to Statcast position abbreviations.
_DEFENSE_TO_CODE = {
    'pitcher': 'P', 'catcher': 'C', 'first': '1B', 'second': '2B',
    'third': '3B', 'shortstop': 'SS', 'left': 'LF', 'center': 'CF',
    'right': 'RF',
}


def _defense_snapshot(linescore: dict) -> tuple:
    """Return (alignment, formation) from a linescore block.

    ``alignment`` maps position code → {id, name} for the nine fielders, from
    the feed's linescore.defense block (which updates after every defensive
    substitution). ``formation`` is the defensive alignment label — Standard /
    Strategic / Infield In / etc. — defaulting to "Standard" when absent.
    """
    raw_defense = linescore.get('defense') or {}
    alignment = {}
    for key, code in _DEFENSE_TO_CODE.items():
        player = raw_defense.get(key) or {}
        if player.get('id'):
            alignment[code] = {
                'id': player['id'],
                'name': player.get('fullName', ''),
            }
    formation = (raw_defense.get('defensiveAlignment')
                 or raw_defense.get('formation')
                 or 'Standard')
    return alignment, formation


def _historical_defense_snapshot(data: dict, prefix: list) -> tuple:
    """Reconstruct the defensive alignment in effect for a historical moment.

    The live feed's ``linescore.defense`` only carries the CURRENT alignment,
    so a replayed at-bat's snapshot would otherwise keep showing today's
    fielders during rewind mode. Which team was in the field decides how the
    historical alignment is recovered:

    * The SAME team the linescore currently shows: walk the substitution
      events that happened after ``prefix``'s moment backwards, undoing each
      swap, to recover the alignment as it stood then.
    * The OTHER team (the snapshot's half-inning had the opposite team in the
      field): the linescore's lineup belongs to the wrong team, so rebuild
      the fielding team's alignment from its starting lineup and walk its
      substitutions forward (see ``_forward_defense_walk``).

    Returns ``(alignment, formation)``, or ``(None, None)`` when the current
    alignment can't be walked to the target (e.g. the boxscore is too sparse
    to rebuild the other team's starting lineup). Callers then fall back to
    the live alignment.
    """
    live_data = data.get('liveData') or {}
    linescore = live_data.get('linescore') or {}
    all_plays = live_data.get('plays', {}).get('allPlays') or []
    if not all_plays or not prefix:
        return None, None

    # The linescore's alignment belongs to the team defending the CURRENT
    # half-inning (the away team in the top, the home team in the bottom).
    current_half = (linescore.get('inningHalf') or '').lower() \
        or ('top' if linescore.get('isTopInning') else 'bottom')
    current_side = ('home' if current_half == 'top'
                    else 'away' if current_half == 'bottom' else None)
    target_half = (prefix[-1].get('about') or {}).get('halfInning')
    target_side = ('home' if target_half == 'top'
                   else 'away' if target_half == 'bottom' else None)

    # Fallback formation label; the Statcast lookup in _game_state_snapshot
    # overrides it with the formation actually in effect for the replayed pitch.
    _, formation = _defense_snapshot(linescore)

    if target_side is not None and current_side is not None and target_side != current_side:
        # The snapshot's half-inning had the OTHER team in the field, whose
        # historical lineup can't be derived from the linescore. Rebuild it
        # from the team's starting lineup and walk forward instead.
        alignment = _forward_defense_walk(data, prefix, target_side)
        if not alignment:
            return None, None
        return alignment, formation

    alignment, _ = _defense_snapshot(linescore)
    if not alignment:
        return None, None

    # fullName lookup for every player who appeared in the game (the boxscore
    # includes substitutes, whose names the substitution events don't repeat).
    names = {}
    box_teams = (live_data.get('boxscore') or {}).get('teams') or {}
    for side in ('away', 'home'):
        players = (box_teams.get(side) or {}).get('players') or {}
        for entry in players.values():
            person = entry.get('person') or {}
            pid = person.get('id') or entry.get('id')
            if pid:
                names[pid] = person.get('fullName') or entry.get('fullName') or ''

    # Undo every substitution that happened after the prefix's moment, newest
    # first. The incoming-player id check both skips the other team's events
    # and guarantees each swap applies to the spot the player actually holds.
    for play in reversed(all_plays[len(prefix):]):
        for ev in reversed(play.get('playEvents') or []):
            event_type = (ev.get('details') or {}).get('eventType')
            if event_type not in ('defensive_substitution', 'pitching_substitution'):
                continue
            new_id = (ev.get('player') or {}).get('id')
            spot = (ev.get('position') or {}).get('abbreviation')
            if new_id is None or spot not in alignment:
                continue
            if alignment.get(spot, {}).get('id') != new_id:
                continue
            description = (ev.get('details') or {}).get('description') or ''
            old_spot = _extract_old_player_position(description)
            if event_type == 'pitching_substitution':
                # The pitcher slot is derived from the target play's matchup
                # below. A double-switch event's replacedPlayer is a position
                # player leaving ("…replacing first baseman X"), so restore
                # him at the position the description names; plain pitching
                # changes carry no replacedPlayer and stop here.
                old_id = (ev.get('replacedPlayer') or {}).get('id')
                if old_spot and old_spot in alignment and old_id:
                    alignment[old_spot] = {'id': old_id, 'name': names.get(old_id, '')}
                continue
            old_id = (ev.get('replacedPlayer') or {}).get('id')
            if old_id is None:
                continue
            old_name = names.get(old_id, '')
            # A defensive shuffle names a different position for the outgoing
            # player than the incoming one ("…replaces first baseman X, playing
            # second base"): whoever was at the incoming player's spot moves to
            # the outgoing player's vacated spot. Undo both legs; otherwise the
            # outgoing player simply returns to the spot (same-position swap).
            if (old_spot and old_spot != spot and old_spot in alignment
                    and alignment.get(old_spot)):
                displaced = alignment[old_spot]
                alignment[old_spot] = {'id': old_id, 'name': old_name}
                alignment[spot] = displaced
            else:
                alignment[spot] = {'id': old_id, 'name': old_name}

    # The pitcher who faced the replayed at-bat comes from its own matchup
    # (the linescore's pitcher is whoever is on the mound right now).
    matchup = prefix[-1].get('matchup') or {}
    pitcher = matchup.get('pitcher') or {}
    if pitcher.get('id') and 'P' in alignment:
        alignment['P'] = {
            'id': pitcher['id'],
            'name': pitcher.get('fullName', ''),
        }

    return alignment, formation


def _forward_defense_walk(data: dict, prefix: list, side: str) -> dict | None:
    """Rebuild ``side``'s defensive alignment as of ``prefix`` from the start.

    Mirrors ``_historical_defense_snapshot``'s reverse walk for the team the
    linescore's current defense does NOT show (the other half-inning's
    fielders). The starting lineup comes from the boxscore: starters carry a
    ``battingOrder`` of 100..900, and each player's first ``allPositions``
    entry is the position they opened the game at (the boxscore's ``position``
    field only reflects where they are now). Substitution, pitching-change and
    defensive-switch events through ``prefix`` are then applied forward. The
    feed lists a shuffle's moves as a chain (a displaced player's switch can
    precede the move that displaces them), so each event simply assigns the
    player's new spot and, at the play boundary, a player who moved belongs
    only at their last-assigned spot.

    Returns the alignment map, or ``None`` when the boxscore is too sparse to
    rebuild the starting lineup (callers then keep the live alignment).
    """
    box_players = (
        ((data.get('liveData') or {}).get('boxscore') or {})
        .get('teams', {}).get(side, {}).get('players') or {}
    )
    names = {}
    team_ids = set()
    for entry in box_players.values():
        pid = (entry.get('person') or {}).get('id') or entry.get('id')
        if pid:
            names[pid] = (entry.get('person') or {}).get('fullName') or entry.get('fullName') or ''
            team_ids.add(pid)

    alignment = {}
    for entry in box_players.values():
        bo = entry.get('battingOrder')
        try:
            boval = int(bo)
        except (TypeError, ValueError):
            continue
        if boval % 100 != 0 or not (100 <= boval <= 900):
            continue  # substitute or pitcher — not part of the starting lineup
        positions = entry.get('allPositions') or []
        pos_abbr = (positions[0].get('abbreviation') if positions
                    else (entry.get('position') or {}).get('abbreviation'))
        if pos_abbr not in ('P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'):
            continue  # designated hitters and pinch roles don't field
        pid = (entry.get('person') or {}).get('id') or entry.get('id')
        if pid is None:
            continue
        alignment[pos_abbr] = {'id': pid, 'name': names.get(pid, '')}
    if len(alignment) < 8:
        return None
    # The starting pitcher carries no battingOrder (so the loop above skips
    # him); the pitcher slot fills from pitching changes and the replayed
    # at-bat's own matchup below.
    alignment.setdefault('P', {})

    # Walk the events through the prefix, assigning each moving player their
    # new spot. Only the target team's players are applied — a play boundary
    # can also carry the other team's switches.
    for play in prefix:
        last_assigned = {}
        for ev in play.get('playEvents') or []:
            new_id = (ev.get('player') or {}).get('id')
            if new_id is None or new_id not in team_ids:
                continue
            event_type = (ev.get('details') or {}).get('eventType')
            spot = (ev.get('position') or {}).get('abbreviation')
            if event_type == 'defensive_substitution':
                old_id = (ev.get('replacedPlayer') or {}).get('id')
                old_spot = _extract_old_player_position(
                    (ev.get('details') or {}).get('description') or ''
                )
                # A shuffle names a different position for the outgoing player
                # ("…replaces first baseman X, playing second base"): the
                # player displaced from the incoming spot moves to the vacated
                # spot. Otherwise the incoming player simply takes the spot.
                if (old_spot and old_spot != spot and old_spot in alignment
                        and alignment[old_spot].get('id') == old_id
                        and alignment.get(spot)):
                    alignment[old_spot] = alignment[spot]
                if spot in alignment:
                    alignment[spot] = {'id': new_id, 'name': names.get(new_id, '')}
                    last_assigned[new_id] = spot
            elif event_type == 'defensive_switch':
                from_spot = _extract_switch_from_position(
                    (ev.get('details') or {}).get('description') or ''
                )
                if (from_spot and from_spot != spot and from_spot in alignment
                        and alignment[from_spot].get('id') == new_id
                        and alignment.get(spot)):
                    alignment[from_spot] = alignment[spot]
                if spot in alignment:
                    alignment[spot] = {'id': new_id, 'name': names.get(new_id, '')}
                    last_assigned[new_id] = spot
            elif event_type == 'pitching_substitution':
                alignment['P'] = {'id': new_id, 'name': names.get(new_id, '')}
                last_assigned[new_id] = 'P'
        # A player who moved at this boundary belongs only at their
        # last-assigned spot (the feed lists a shuffle's moves as a chain).
        for pos in list(alignment):
            pid = alignment[pos].get('id')
            if pid in last_assigned and last_assigned[pid] != pos:
                del alignment[pos]

    # The pitcher who faced the replayed at-bat comes from its own matchup
    # (the linescore's pitcher is whoever is on the mound right now).
    matchup = prefix[-1].get('matchup') or {}
    pitcher = matchup.get('pitcher') or {}
    if pitcher.get('id'):
        alignment['P'] = {
            'id': pitcher['id'],
            'name': pitcher.get('fullName', ''),
        }
    return alignment


def _calculate_challenges(plays: list, current_inning: Optional[int] = 1,
                          away_id: Optional[int] = None, home_id: Optional[int] = None) -> dict:
    """Calculate ABS challenges remaining for away and home teams (max 2).

    Rules:
    - Each team starts regulation (innings 1-9) with 2 challenges.
    - A successful challenge (isOverturned=True) is retained.
    - An unsuccessful challenge (isOverturned=False) deducts 1 challenge.
    - In extra innings (inning >= 10), each team's challenges are refilled to 2.
      Any new extra inning (e.g. 10th, 11th, etc.) also resets/refills challenges to 2.
    """
    away_challenges = 2
    home_challenges = 2
    last_inning = 1

    for play in plays:
        about = play.get('about') or {}
        inning = about.get('inning', 1)
        if inning is None:
            inning = 1

        # Refill challenges upon entering extra innings (inning >= 10) or each subsequent extra inning
        if inning >= 10 and inning > last_inning:
            away_challenges = 2
            home_challenges = 2
        last_inning = max(last_inning, inning)

        # Collect unique reviewDetails objects on this play (both play-level and event-level)
        reviews = []
        play_rd = play.get('reviewDetails')
        if play_rd and isinstance(play_rd, dict):
            reviews.append(play_rd)

        for ev in play.get('playEvents') or []:
            ev_rd = ev.get('reviewDetails')
            if ev_rd and isinstance(ev_rd, dict) and ev_rd not in reviews:
                reviews.append(ev_rd)

        for rd in reviews:
            is_overturned = rd.get('isOverturned')
            # Only an unsuccessful challenge (stands/confirmed, isOverturned=False) costs a challenge
            if is_overturned is False:
                team_challenged = None
                challenger_team_id = rd.get('challengeTeamId') or (rd.get('team') or {}).get('id')
                if challenger_team_id:
                    if away_id and challenger_team_id == away_id:
                        team_challenged = 'away'
                    elif home_id and challenger_team_id == home_id:
                        team_challenged = 'home'

                if not team_challenged:
                    player = rd.get('player') or {}
                    p_id = player.get('id')
                    p_name = player.get('fullName')
                    matchup = play.get('matchup') or {}
                    batter = matchup.get('batter') or {}
                    pitcher = matchup.get('pitcher') or {}
                    is_top = about.get('isTopInning', True)
                    batting_side = 'away' if is_top else 'home'
                    fielding_side = 'home' if is_top else 'away'

                    if (p_id and p_id == batter.get('id')) or (p_name and p_name == batter.get('fullName')):
                        team_challenged = batting_side
                    elif (p_id and p_id == pitcher.get('id')) or (p_name and p_name == pitcher.get('fullName')):
                        team_challenged = fielding_side
                    else:
                        # Fallback for batter vs catcher/pitcher ball-strike challenges
                        team_challenged = batting_side

                if team_challenged == 'away':
                    away_challenges = max(0, away_challenges - 1)
                elif team_challenged == 'home':
                    home_challenges = max(0, home_challenges - 1)

    # Refill if the current inning is in extra innings and advances past the plays seen
    if current_inning and current_inning >= 10 and current_inning > last_inning:
        away_challenges = 2
        home_challenges = 2

    return {
        'away': away_challenges,
        'home': home_challenges,
    }


def _game_state_snapshot(data: dict, target_play: dict,
                         target_pitch: dict, pitch_index: Optional[int],
                         prefix: Optional[list] = None,
                         game_pk: str = GAME_PK,
                         game_date: str | None = None) -> dict:
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
    if game_date is None:
        game_date = data.get('gameData', {}).get('datetime', {}).get('officialDate')
    if prefix is None:
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
    # The index of the play's last *pitch* event (a play can carry non-pitch
    # events after its final pitch, e.g. a stolen-base or runner event). The
    # snapshot for that final pitch represents the play's resolved state.
    target_pitch_indices = [i for i, ev in enumerate(target_events) if ev.get('isPitch')]
    target_is_final_pitch = (
        pitch_index is None
        or (target_pitch_indices and pitch_index >= target_pitch_indices[-1])
    )
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
                    and about.get('isComplete') and live.get('runs') is not None else derived_runs[side],
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
    game_type = (game_data.get('game') or {}).get('type')
    current_pitcher_id = matchup.get('pitcher', {}).get('id')
    pitches_thrown = sum(
        1 for play in prefix
        if play.get('matchup', {}).get('pitcher', {}).get('id') == current_pitcher_id
        for event in play.get('playEvents', []) if event.get('isPitch')
    )
    outs = target_count.get('outs')
    # The pitch's ``count.outs`` is the outs BEFORE the at-bat began. Once the
    # play has fully resolved (the feed carries its final result/runners), the
    # scoreboard must show the outs AFTER the play — e.g. a flyout with one
    # out already in must report two, a double play two more. Add the outs the
    # play recorded (batter + any runners put out, all listed in the play's
    # ``runners``) to the pre-play total. Only for the play's final pitch: a
    # queued mid-at-bat pitch's snapshot stays pre-resolution.
    if outs is not None and about.get('isComplete') and target_is_final_pitch:
        outs = outs + sum(
            1 for r in target_play.get('runners', [])
            if (r.get('movement') or {}).get('isOut')
        )
    if outs is None:
        outs = linescore.get('outs') if target_is_latest else None

    # Defensive alignment + formation as of this snapshot's moment, so the
    # replayed at-bat can drive the defense panel during rewind mode. The
    # linescore only carries the CURRENT alignment; walk the substitutions
    # that happened after this moment to recover the historical one (or, when
    # the other team was in the field, rebuild it from the starting lineup).
    # Fall back to the live alignment when the reconstruction can't apply.
    defense_alignment, fallback_formation = _historical_defense_snapshot(data, prefix)
    if defense_alignment is None:
        defense_alignment, defense_formation = _defense_snapshot(linescore)
    else:
        # The formation for the replayed pitch comes from its Statcast row
        # (the linescore only knows the CURRENT formation); fall back to the
        # linescore's label when Savant hasn't ingested the game yet.
        defense_formation = _formation_for_pitch(
            game_pk, game_date, target_play, target_pitch,
        )
        if defense_formation is None:
            defense_formation = fallback_formation

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
    # Outcome summary for the batter (popover on the H–AB line).
    batter_summary = _batter_play_summary(matchup.get('batter', {}).get('id'), prefix)
    batter_season_stats = batter_entry.get('seasonStats', {}).get('batting') or {}
    pitcher_season_stats = box_entry(current_pitcher_id).get('seasonStats', {}).get('pitching') or {}
    # Game-line totals for the pitcher as of this snapshot (mirrors the live
    # /api/game-state computation), so the frozen/replay scoreboard keeps the
    # pitcher's SO/BB/strikes/pitches hover populated instead of dropping it.
    pitcher_game_line = {'strikeouts': 0, 'walks': 0, 'strikesThrown': 0, 'pitchesThrown': 0}
    for play in prefix:
        if play.get('matchup', {}).get('pitcher', {}).get('id') != current_pitcher_id:
            continue
        play_event = (play.get('result') or {}).get('event') or ''
        if 'strikeout' in play_event.lower():
            pitcher_game_line['strikeouts'] += 1
        if play_event.lower() in ('walk', 'intent walk', 'hit by pitch'):
            pitcher_game_line['walks'] += 1
        for event in play.get('playEvents', []):
            if not event.get('isPitch'):
                continue
            pitcher_game_line['pitchesThrown'] += 1
            if (event.get('count') or {}).get('strikes') is not None:
                code = ((event.get('details') or {}).get('call') or {}).get('code')
                if code in ('C', 'S', 'F', 'W', 'T', 'M'):
                    pitcher_game_line['strikesThrown'] += 1
    status = game_data.get('status', {})
    away_id = (game_data.get('teams') or {}).get('away', {}).get('id')
    home_id = (game_data.get('teams') or {}).get('home', {}).get('id')
    challenges = _calculate_challenges(prefix, inning_number, away_id, home_id)
    (review, review_is_overturned, review_challenger,
     review_type, review_target, review_team) = _parse_review_info(target_play)
    target_terminal = (
        target_is_latest
        and (
            status.get('abstractGameState') == 'Final'
            or status.get('detailedState') in ('Final', 'Game Over', 'Completed Early')
        )
    )
    resolved_state = (
        'End' if target_terminal
        else ('Top' if is_top else 'Bottom' if half else linescore.get('inningState'))
    )
    return {
        'success': True,
        'teams': teams,
        'score': score,
        'challenges': challenges,
        'review': review,
        'reviewIsOverturned': review_is_overturned,
        'reviewChallenger': review_challenger,
        'reviewType': review_type,
        'reviewTarget': review_target,
        'reviewTeam': review_team,
        'inning': {
            'number': inning_number,
            'ordinal': about.get('inningOrdinal') or _inning_ordinal(inning_number),
            'state': resolved_state,
            'isTop': is_top,
        },
        'outs': outs,
        'count': {'balls': balls, 'strikes': strikes},
        'bases': _occupied_bases(prefix, game_type),
        'pitcher': matchup.get('pitcher', {}).get('fullName', '—'),
        'pitcherId': matchup.get('pitcher', {}).get('id'),
        'batter': matchup.get('batter', {}).get('fullName', '—'),

        'batterLine': batter_line,
        'batterSummary': batter_summary,
        'pitchNumber': target_pitch.get('pitchNumber'),
        'pitchesThrown': pitches_thrown,
        'pitcherGameLine': pitcher_game_line,
        'gameState': status.get('detailedState'),
        'isLive': status.get('abstractGameState') == 'Live',
        'abstractGameState': status.get('abstractGameState'),
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
        # Defensive alignment (position code → player) as of the snapshot.
        'defenseAlignment': defense_alignment,
        # Formation type: Standard / Strategic / Infield In / etc.
        'defenseFormation': defense_formation,
    }


# ---------------------------------------------------------------------------
# Lightweight status endpoint + broadcast game-state endpoint
# ---------------------------------------------------------------------------

# Maps the feed's descriptive position labels (lowercase, as they appear in
# substitution descriptions) to the standard Statcast position abbreviations.
# Used to include a position code in substitution notices.
_POSITION_LABEL_TO_ABBREV = {
    'center fielder': 'CF',
    'center field': 'CF',
    'left fielder': 'LF',
    'left field': 'LF',
    'right fielder': 'RF',
    'right field': 'RF',
    'first baseman': '1B',
    'first base': '1B',
    'second baseman': '2B',
    'second base': '2B',
    'third baseman': '3B',
    'third base': '3B',
    'shortstop': 'SS',
    'catcher': 'C',
    'pitcher': 'P',
    'designated hitter': 'DH',
    'outfielder': 'OF',
    'infielder': 'IF',
}


def _extract_old_player_position(description: str) -> str | None:
    """Pull the position abbreviation from a substitution description.

    The feed writes descriptions like:
      "Defensive Substitution: Enrique Hernandez replaces center fielder
       Andy Pages, batting 3rd, playing center field."
      "Offensive Substitution: Pinch-hitter David Hensley replaces center fielder
       Trent Grisham."

    We scan for known position labels in the "replaces ..." portion and map
    them to their abbreviation. Returns None when no position is recognized.
    """
    if not description:
        return None
    # Only look at the part after "replaces" — the old player and position.
    after_replaces = description.split(' replaces ', 1)[-1] if ' replaces ' in description else description
    lower = after_replaces.lower()
    for label, abbrev in _POSITION_LABEL_TO_ABBREV.items():
        if label in lower:
            return abbrev
    words = after_replaces.split()
    for w in words[:3]:
        clean_w = w.strip('(),.:;').upper()
        if clean_w in ('CF', 'LF', 'RF', '1B', '2B', '3B', 'SS', 'C', 'P', 'DH', 'OF', 'IF'):
            return clean_w
    return None


def _find_player_position(data: dict, player_name: str | None) -> str | None:
    """Find a player's position abbreviation by searching boxscore, gameData, and defense."""
    if not data or not player_name:
        return None
    name_clean = player_name.strip().lower()
    if not name_clean:
        return None

    # 1. Search boxscore players for both teams
    box_teams = (data.get('liveData') or {}).get('boxscore', {}).get('teams') or {}
    for side in ('away', 'home'):
        for p in (box_teams.get(side) or {}).get('players', {}).values():
            p_name = ((p.get('person') or {}).get('fullName') or '').strip().lower()
            if p_name == name_clean:
                pos = (p.get('position') or {}).get('abbreviation')
                if pos and not pos.isdigit():
                    return pos
                all_pos = p.get('allPositions') or []
                if all_pos and all_pos[0].get('abbreviation'):
                    return all_pos[0].get('abbreviation')

    # 2. Search gameData players
    for p in (data.get('gameData') or {}).get('players', {}).values():
        p_name = (p.get('fullName') or '').strip().lower()
        if p_name == name_clean:
            pos = (p.get('primaryPosition') or {}).get('abbreviation')
            if pos and not pos.isdigit():
                return pos

    # 3. Search linescore defense
    raw_defense = ((data.get('liveData') or {}).get('linescore') or {}).get('defense') or {}
    for key, code in _DEFENSE_TO_CODE.items():
        p = raw_defense.get(key) or {}
        p_name = (p.get('fullName') or '').strip().lower()
        if p_name == name_clean:
            return code

    return None


# Maps the position labels used in defensive-switch descriptions ("Defensive
# switch from third base to second base for …") to Statcast abbreviations.
# These read "third base", not "third baseman", so they need their own table.
_SWITCH_FROM_LABELS = {
    'center field': 'CF', 'left field': 'LF', 'right field': 'RF',
    'first base': '1B', 'second base': '2B', 'third base': '3B',
    'shortstop': 'SS', 'catcher': 'C', 'pitcher': 'P',
}


def _extract_switch_from_position(description: str) -> str | None:
    """Pull the position a defensive switch leaves, from its description.

    The feed writes descriptions like:
      "Defensive switch from third base to second base for Connor Norby."

    Returns the "from" position's abbreviation (3B above), or None when the
    switch names no from-position — "Luis Vázquez remains in the game as the
    shortstop." means the player was not previously fielding, so there is no
    vacated spot to displace anyone into.
    """
    if not description:
        return None
    lower = description.lower()
    if ' from ' not in lower or ' to ' not in lower:
        return None
    for label, abbrev in _SWITCH_FROM_LABELS.items():
        if f' from {label} to ' in lower:
            return abbrev
    return None


def _extract_new_player_position(description: str, ev: dict, event_type: str) -> str | None:
    """Pull the new (incoming) player's position abbreviation from a substitution event.

    - Pitching changes: always 'P'.
    - Defensive substitutions: scanned from "playing <position>" at the tail
      of the description, e.g. "…, playing center field" → 'CF'.
    - Offensive substitutions: the feed's ``position.abbreviation`` field
      carries the lineup slot (not a defensive position), so we fall back to
      scanning the description for a "playing …" clause; returns None when
      neither is available.
    """
    if event_type == 'pitching_substitution':
        return 'P'

    if not description:
        return None

    # Defensive subs often include the new player's position in a
    # "playing <position>" clause at the end of the description:
    #   "…, batting 3rd, playing center field."
    lower = description.lower()
    playing_idx = lower.rfind('playing ')
    if playing_idx >= 0:
        tail = description[playing_idx + len('playing '):].strip().rstrip('.')
        for label, abbrev in _POSITION_LABEL_TO_ABBREV.items():
            if tail.lower() == label:
                return abbrev

    # For offensive subs the feed event may carry the new player's position
    # directly (the batting-order slot, though occasionally a real position).
    pos = (ev.get('position') or {}).get('abbreviation')
    if pos:
        # Filter out obvious batting-order codes (numbers only).
        if not pos.isdigit():
            return pos

    return None


def _parse_sub_event(ev: dict, fallback_new: str = None) -> tuple[str | None, str | None]:
    """Extract (new_player, old_player) names from a substitution action event.

    The feed's ``details.description`` follows patterns like:
      "Pitching Change: Julian Garcia replaces Nick Lodolo."
      "Offensive Substitution: Pinch-runner Leo Rivas replaces Taylor Ward."
      "Defensive Substitution: Enrique Hernández replaces center fielder Andy
         Pages, batting 3rd, playing center field."

    For pitching/offensive subs the names are clean after "replaces".
    For defensive subs the old player's name is preceded by a position label
    ("center fielder", "shortstop", etc.) and followed by a comma clause with
    batting/position info that must be stripped.

    Returns (new_player, old_player) or (fallback_new, None) if unparseable.
    """
    desc = (ev.get('details') or {}).get('description') or ''
    if not desc:
        return (fallback_new, None)
    after_colon = desc.split(':', 1)[-1].strip().rstrip('.')
    parts = after_colon.split(' replaces ')
    new_player = parts[0].strip() if parts and parts[0].strip() else fallback_new
    raw_old = parts[1].strip() if len(parts) > 1 and parts[1].strip() else None

    # Remove the role prefix from the new player's name.
    if new_player:
        for prefix in ('Pinch-runner ', 'Pinch-hitter '):
            if new_player.startswith(prefix):
                new_player = new_player[len(prefix):].strip()
                break

    # For defensive substitutions, the old player's name is preceded by a
    # position label and followed by a comma clause. Strip both so only the
    # player name remains, e.g. "center fielder Andy Pages, batting 3rd,
    # playing center field" -> "Andy Pages".
    old_player = None
    if raw_old:
        # Drop everything from the first comma onward (batting/position info).
        old_player = raw_old.split(',', 1)[0].strip()
        # Strip a leading position label: the feed writes "<position> <Name>"
        # where <position> is a lowercase phrase like "center fielder",
        # "left fielder", "shortstop", "second baseman", "first baseman",
        # "third baseman", "right fielder", "catcher", "pitcher",
        # "designated hitter".
        pos_labels = [
            'center fielder ', 'left fielder ', 'right fielder ',
            'first baseman ', 'second baseman ', 'third baseman ',
            'shortstop ', 'catcher ', 'pitcher ', 'designated hitter ',
            'pinch runner ', 'pinch hitter ',
        ]
        old_lower = old_player.lower()
        for label in pos_labels:
            if old_lower.startswith(label):
                old_player = old_player[len(label):].strip()
                break

    return (new_player or fallback_new, old_player)


def _parse_review_info(current_play: dict) -> tuple:
    """Extract review fields: (review, review_is_overturned, review_challenger,
    review_type, review_target, review_team) from a play.
    """
    review_details = current_play.get('reviewDetails') or {}
    if not review_details:
        for ev in reversed(current_play.get('playEvents') or []):
            if ev.get('reviewDetails'):
                review_details = ev.get('reviewDetails')
                break

    if not review_details:
        return False, None, None, None, None, None

    review = True
    review_is_overturned = review_details.get('isOverturned')
    review_type = review_details.get('reviewType')

    # Who challenged
    player = review_details.get('player') or {}
    challenger = player.get('fullName')
    if not challenger:
        challenger = review_details.get('challenger') or (review_details.get('team') or {}).get('name')

    team = (
        (review_details.get('team') or {}).get('triCode')
        or (review_details.get('team') or {}).get('abbreviation')
    )

    # What was challenged (target)
    target = review_details.get('call') or review_details.get('challengeType')
    desc = review_details.get('description') or ''

    if not target and desc:
        desc_lower = desc.lower()
        if 'strike' in desc_lower:
            target = 'Called Strike'
        elif 'ball' in desc_lower:
            target = 'Called Ball'
        elif any(k in desc_lower for k in ('safe', 'out', 'tag', 'force', 'catch', 'foul', 'fair')):
            target = desc

    if not target:
        # Check the play's pitch events for pitch call description (ABS challenge)
        pitch_events = [ev for ev in (current_play.get('playEvents') or []) if ev.get('isPitch')]
        if pitch_events:
            last_pitch = pitch_events[-1]
            call = (last_pitch.get('details') or {}).get('call') or {}
            call_desc = call.get('description') or (last_pitch.get('details') or {}).get('description') or ''
            call_code = call.get('code')
            if 'strike' in call_desc.lower() or call_code in ('C', 'S'):
                target = 'Called Strike'
            elif 'ball' in call_desc.lower() or call_code == 'B':
                target = 'Called Ball'
            elif call_desc:
                target = call_desc

    if not target:
        matchup = current_play.get('matchup') or {}
        batter_id = matchup.get('batter', {}).get('id')
        pitcher_id = matchup.get('pitcher', {}).get('id')
        p_id = player.get('id')
        if p_id and p_id == batter_id:
            target = 'Called Strike'
        elif p_id and p_id == pitcher_id:
            target = 'Called Ball'
        elif review_type == 'MJ' or not review_type:
            target = 'Called Strike'
        else:
            target = 'Call on Field'

    if not challenger:
        challenger = 'Batter' if (target in ('Called Strike', 'Called Ball') or review_type == 'MJ') else 'Manager'

    return review, review_is_overturned, challenger, review_type, target, team


def _game_status_snapshot(data: dict, game_pk: str = GAME_PK) -> dict:
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

    # Scan the current play's action events for mound visits, pitching
    # substitutions, and offensive substitutions (pinch hitter/runner). The
    # feed embeds these as non-pitch ``playEvents`` with
    # ``details.eventType`` of 'mound_visit', 'pitching_substitution', or
    # 'offensive_substitution'. This is far more reliable than inferring a
    # pitching change from pitcher-identity comparison (which can't
    # distinguish a real relief appearance from the defensive team simply
    # swapping after an inning turns over).
    mound_visit = False
    pitching_change = False
    pitching_change_pitcher = None
    pitching_change_old_pitcher = None
    pitching_change_position = None
    pitching_change_new_position = None
    offensive_sub = False
    offensive_sub_new = None
    offensive_sub_old = None
    offensive_sub_role = None  # 'Pinch Hitter' or 'Pinch Runner'
    offensive_sub_position = None
    offensive_sub_new_position = None
    defensive_sub = False
    defensive_sub_new = None
    defensive_sub_old = None
    defensive_sub_position = None
    defensive_sub_new_position = None
    # ABS challenge / umpire review detection.
    review = False
    review_is_overturned = None
    review_challenger = None
    review_type = None
    for ev in current_play.get('playEvents') or []:
        details = ev.get('details') or {}
        et = details.get('eventType') or ''
        if et == 'mound_visit':
            mound_visit = True
        elif et == 'pitching_substitution':
            pitching_change = True
            new_name, old_name = _parse_sub_event(ev, pitcher.get('fullName'))
            pitching_change_pitcher = new_name
            pitching_change_old_pitcher = old_name
            pitching_change_position = 'P'
            pitching_change_new_position = _extract_new_player_position(
                details.get('description') or '', ev, et,
            )
        elif et == 'offensive_substitution':
            offensive_sub = True
            new_name, old_name = _parse_sub_event(ev)
            offensive_sub_new = new_name
            offensive_sub_old = old_name
            # Pull the old player's position abbreviation from the description or data lookup.
            desc = details.get('description') or ''
            offensive_sub_position = _extract_old_player_position(desc)
            if not offensive_sub_position and old_name:
                offensive_sub_position = _find_player_position(data, old_name)
            offensive_sub_new_position = _extract_new_player_position(desc, ev, et)
            if not offensive_sub_new_position and new_name:
                offensive_sub_new_position = _find_player_position(data, new_name)
            # Determine if pinch hitter or pinch runner from the position.
            pos_name = (ev.get('position') or {}).get('name') or ''
            if 'Runner' in pos_name:
                offensive_sub_role = 'Pinch Runner'
            elif 'Hitter' in pos_name or 'Batter' in pos_name:
                offensive_sub_role = 'Pinch Hitter'
            else:
                # Fall back to parsing the description for the role.
                desc = details.get('description') or ''
                if 'pinch-runner' in desc.lower():
                    offensive_sub_role = 'Pinch Runner'
                elif 'pinch-hitter' in desc.lower():
                    offensive_sub_role = 'Pinch Hitter'
                else:
                    offensive_sub_role = 'Pinch Hitter'
        elif et == 'defensive_substitution':
            defensive_sub = True
            new_name, old_name = _parse_sub_event(ev)
            defensive_sub_new = new_name
            defensive_sub_old = old_name
            desc = details.get('description') or ''
            defensive_sub_position = _extract_old_player_position(desc)
            if not defensive_sub_position and old_name:
                defensive_sub_position = _find_player_position(data, old_name)
            defensive_sub_new_position = _extract_new_player_position(desc, ev, et)
            if not defensive_sub_new_position and new_name:
                defensive_sub_new_position = _find_player_position(data, new_name)

    # Check for an ABS challenge or umpire review on the current play.
    (review, review_is_overturned, review_challenger,
     review_type, review_target, review_team) = _parse_review_info(current_play)

    linescore = live_data.get('linescore') or {}
    # Defensive alignment: position-code → {id, name} for the nine fielders,
    # plus the formation label, from the live feed's linescore.defense block.
    # The live feed no longer carries a per-pitch defensive alignment, so the
    # formation resolves from the newest pitch Statcast has ingested; fall
    # back to the linescore's label when Savant hasn't caught up yet.
    defense_alignment, fallback_formation = _defense_snapshot(linescore)
    game_date = data.get('gameData', {}).get('datetime', {}).get('officialDate')
    defense_formation = _live_formation_from_savant(
        game_pk, game_date, (plays.get('allPlays') or []),
    ) or fallback_formation
    status = game_data.get('status') or {}
    abstract_state = status.get('abstractGameState')
    detailed_state = status.get('detailedState')
    is_terminal_game = (
        abstract_state == 'Final'
        or detailed_state in ('Final', 'Game Over', 'Completed Early')
    )
    raw_inning_state = linescore.get('inningState')
    resolved_inning_state = (
        'End' if (is_terminal_game and raw_inning_state not in ('Middle', 'End'))
        else raw_inning_state
    )
    return {
        "success": True,
        "gameState": detailed_state,
        "isLive": abstract_state == "Live",
        "abstractGameState": abstract_state,
        "detailedState": detailed_state,
        "pitcher": pitcher.get('fullName'),
        "pitcherId": pitcher.get('id'),
        # Half-inning identity so the frontend can tell a real mid-inning
        # pitching change from the other team's pitcher taking the mound after
        # an inning turns over (which must NOT read as a pitching change).
        "inningNumber": linescore.get('currentInning'),
        "isTopInning": linescore.get('isTopInning'),
        "inningState": resolved_inning_state,
        # Action-event flags from the current play's playEvents so the
        # scorebug can surface them without inferring from pitcher identity.
        "moundVisit": mound_visit,
        "pitchingChange": pitching_change,
        # The new pitcher's name so the scorebug shows "Pitching Change: X"
        # instead of a bare "Pitching Change".
        "pitchingChangePitcher": pitching_change_pitcher,
        "pitchingChangeOldPitcher": pitching_change_old_pitcher,
        "pitchingChangePosition": pitching_change_position,
        "pitchingChangeNewPosition": pitching_change_new_position,
        # Offensive substitution (pinch hitter / pinch runner) flags + names.
        "offensiveSub": offensive_sub,
        "offensiveSubRole": offensive_sub_role,
        "offensiveSubNew": offensive_sub_new,
        "offensiveSubOld": offensive_sub_old,
        "offensiveSubPosition": offensive_sub_position,
        "offensiveSubNewPosition": offensive_sub_new_position,
        # Defensive substitution (position player swap) flags + names.
        "defensiveSub": defensive_sub,
        "defensiveSubNew": defensive_sub_new,
        "defensiveSubOld": defensive_sub_old,
        "defensiveSubPosition": defensive_sub_position,
        "defensiveSubNewPosition": defensive_sub_new_position,
        # ABS challenge / umpire review.
        "review": review,
        "reviewIsOverturned": review_is_overturned,
        "reviewChallenger": review_challenger,
        "reviewType": review_type,
        "reviewTarget": review_target,
        "reviewTeam": review_team,
        # Current defensive alignment (position code → player name).
        "defenseAlignment": defense_alignment,
        # Formation type: Standard / Strategic / Infield In / etc.
        "defenseFormation": defense_formation,
    }


@app.get("/api/game-status")
def get_game_status(game_pk: str = GAME_PK):
    """Return delay/review/live status and the active pitcher only.

    This endpoint intentionally avoids score, box-score, count, and season-stat
    parsing. The frozen scorebug polls it once per second so a delay or pitching
    change can appear without fetching/building the full scoreboard payload.
    """
    print(f"GAME STATUS... Polling game {game_pk}")
    data = _fetch_feed(game_pk)
    try:
        return _game_status_snapshot(data, game_pk)
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
    data = _fetch_feed(game_pk)
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
        # game.type gates the extra-innings ghost runner (regular season only).
        bases = _occupied_bases(
            all_plays, (game_data.get('game') or {}).get('type'),
        )

        # Pitch total for the current pitcher, mirroring _build_trajectory_payload.
        pitcher_id = matchup.get('pitcher', {}).get('id')
        pitcher_game_line = {"strikeouts": 0, "walks": 0, "strikesThrown": 0, "pitchesThrown": 0}
        for play in all_plays:
            if play.get('matchup', {}).get('pitcher', {}).get('id') != pitcher_id:
                continue
            result = play.get('result') or {}
            event = (result.get('event') or '').lower()
            if 'strikeout' in event:
                pitcher_game_line['strikeouts'] += 1
            if event in ('walk', 'intent walk', 'hit by pitch'):
                pitcher_game_line['walks'] += 1
            for event_data in play.get('playEvents', []):
                if event_data.get('isPitch'):
                    pitcher_game_line['pitchesThrown'] += 1
                    if (event_data.get('count') or {}).get('strikes') is not None:
                        # Count called/swinging/foul strikes from pitch details;
                        # the final count is not a reliable pitch-level total.
                        code = ((event_data.get('details') or {}).get('call') or {}).get('code')
                        if code in ('C', 'S', 'F', 'W', 'T', 'M'):
                            pitcher_game_line['strikesThrown'] += 1
        pitches_thrown = pitcher_game_line['pitchesThrown']

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

        # Outcome summary for the current batter (popover on the H–AB line).
        batter_summary = _batter_play_summary(batter_id, all_plays)

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

        # Scan the current play's action events for mound visits, pitching
        # substitutions, and offensive substitutions (same logic as
        # _game_status_snapshot) so the non-frozen scorebug — which reads
        # liveStatus from this endpoint — can surface them without inferring
        # from pitcher-identity comparison.
        mound_visit = False
        pitching_change = False
        pitching_change_pitcher = None
        pitching_change_old_pitcher = None
        pitching_change_position = None
        pitching_change_new_position = None
        offensive_sub = False
        offensive_sub_new = None
        offensive_sub_old = None
        offensive_sub_role = None
        offensive_sub_position = None
        offensive_sub_new_position = None
        defensive_sub = False
        defensive_sub_new = None
        defensive_sub_old = None
        defensive_sub_position = None
        defensive_sub_new_position = None
        review = False
        review_is_overturned = None
        review_challenger = None
        review_type = None
        live_pitcher_name = matchup.get('pitcher', {}).get('fullName')
        for ev in current_play.get('playEvents') or []:
            details = ev.get('details') or {}
            et = details.get('eventType') or ''
            if et == 'mound_visit':
                mound_visit = True
            elif et == 'pitching_substitution':
                pitching_change = True
                new_name, old_name = _parse_sub_event(ev, live_pitcher_name)
                pitching_change_pitcher = new_name
                pitching_change_old_pitcher = old_name
                pitching_change_position = 'P'
                pitching_change_new_position = _extract_new_player_position(
                    details.get('description') or '', ev, et,
                )
            elif et == 'offensive_substitution':
                offensive_sub = True
                new_name, old_name = _parse_sub_event(ev)
                offensive_sub_new = new_name
                offensive_sub_old = old_name
                pos_desc = details.get('description') or ''
                offensive_sub_position = _extract_old_player_position(pos_desc)
                if not offensive_sub_position and old_name:
                    offensive_sub_position = _find_player_position(data, old_name)
                offensive_sub_new_position = _extract_new_player_position(pos_desc, ev, et)
                if not offensive_sub_new_position and new_name:
                    offensive_sub_new_position = _find_player_position(data, new_name)
                pos_name = (ev.get('position') or {}).get('name') or ''
                if 'Runner' in pos_name:
                    offensive_sub_role = 'Pinch Runner'
                elif 'Hitter' in pos_name or 'Batter' in pos_name:
                    offensive_sub_role = 'Pinch Hitter'
                else:
                    desc = details.get('description') or ''
                    if 'pinch-runner' in desc.lower():
                        offensive_sub_role = 'Pinch Runner'
                    elif 'pinch-hitter' in desc.lower():
                        offensive_sub_role = 'Pinch Hitter'
                    else:
                        offensive_sub_role = 'Pinch Hitter'
            elif et == 'defensive_substitution':
                defensive_sub = True
                new_name, old_name = _parse_sub_event(ev)
                defensive_sub_new = new_name
                defensive_sub_old = old_name
                ddesc = details.get('description') or ''
                defensive_sub_position = _extract_old_player_position(ddesc)
                if not defensive_sub_position and old_name:
                    defensive_sub_position = _find_player_position(data, old_name)
                defensive_sub_new_position = _extract_new_player_position(ddesc, ev, et)
                if not defensive_sub_new_position and new_name:
                    defensive_sub_new_position = _find_player_position(data, new_name)

        # ABS challenge / umpire review on the current play.
        (review, review_is_overturned, review_challenger,
         review_type, review_target, review_team) = _parse_review_info(current_play)

        # Defensive alignment: position-code → {id, name} for the nine fielders.
        defense_alignment, fallback_formation = _defense_snapshot(linescore)
        # The live feed no longer carries a per-pitch defensive alignment, so
        # resolve the CURRENT formation from the newest pitch Statcast has
        # ingested (infield-in / strategic / shift); fall back to the
        # linescore's label when Savant hasn't caught up yet.
        game_date = data.get('gameData', {}).get('datetime', {}).get('officialDate')
        defense_formation = _live_formation_from_savant(
            game_pk, game_date, (live_data.get('plays') or {}).get('allPlays') or [],
        ) or fallback_formation

        status = game_data.get('status', {})
        abstract_state = status.get('abstractGameState')
        detailed_state = status.get('detailedState')
        is_terminal_game = (
            abstract_state == 'Final'
            or detailed_state in ('Final', 'Game Over', 'Completed Early')
        )
        raw_inning_state = linescore.get('inningState')
        resolved_inning_state = (
            'End' if (is_terminal_game and raw_inning_state not in ('Middle', 'End'))
            else raw_inning_state
        )
        away_id = (game_data.get('teams') or {}).get('away', {}).get('id')
        home_id = (game_data.get('teams') or {}).get('home', {}).get('id')
        current_inning_num = linescore.get('currentInning') or 1
        challenges = _calculate_challenges(all_plays, current_inning_num, away_id, home_id)
        return {
            "success": True,
            "teams": teams,
            "score": score,
            "challenges": challenges,
            "inning": {
                "number": linescore.get('currentInning'),
                "ordinal": linescore.get('currentInningOrdinal'),
                "state": resolved_inning_state,
                "isTop": linescore.get('isTopInning'),
            },
            "outs": outs,
            "count": {"balls": balls, "strikes": strikes},
            "bases": bases,
            "pitcher": matchup.get('pitcher', {}).get('fullName', '—'),
            "pitcherId": matchup.get('pitcher', {}).get('id'),
            "batter": matchup.get('batter', {}).get('fullName', '—'),
            "batterLine": batter_line,
            "batterSummary": batter_summary,
            "pitchNumber": current_play.get('pitchNumber'),
            "pitchesThrown": pitches_thrown,
            "pitcherGameLine": pitcher_game_line,
            "gameState": detailed_state,
            "isLive": abstract_state == 'Live',
            "abstractGameState": abstract_state,
            "venue": (game_data.get('venue') or {}).get('name'),
            # Season stats for the current matchup, for the hover popovers.
            "batterSeason": batter_season,
            "pitcherSeason": pitcher_season,
            # Action-event flags for the game-status label (mound visit /
            # pitching change), so the non-frozen scorebug matches the frozen
            # one's behavior.
            "moundVisit": mound_visit,
            "pitchingChange": pitching_change,
            # The new pitcher's name so the scorebug shows
            # "Pitching Change: X" instead of a bare "Pitching Change".
            "pitchingChangePitcher": pitching_change_pitcher,
            "pitchingChangeOldPitcher": pitching_change_old_pitcher,
            "pitchingChangePosition": pitching_change_position,
            "pitchingChangeNewPosition": pitching_change_new_position,
            # Offensive substitution (pinch hitter / pinch runner).
            "offensiveSub": offensive_sub,
            "offensiveSubRole": offensive_sub_role,
            "offensiveSubNew": offensive_sub_new,
            "offensiveSubOld": offensive_sub_old,
            "offensiveSubPosition": offensive_sub_position,
            "offensiveSubNewPosition": offensive_sub_new_position,
            # Defensive substitution (position player swap).
            "defensiveSub": defensive_sub,
            "defensiveSubNew": defensive_sub_new,
            "defensiveSubOld": defensive_sub_old,
            "defensiveSubPosition": defensive_sub_position,
            "defensiveSubNewPosition": defensive_sub_new_position,
            # ABS challenge / umpire review.
            "review": review,
            "reviewIsOverturned": review_is_overturned,
            "reviewChallenger": review_challenger,
            "reviewType": review_type,
            "reviewTarget": review_target,
            "reviewTeam": review_team,
            # Half-inning identity for the status label.
            "inningNumber": linescore.get('currentInning'),
            "isTopInning": linescore.get('isTopInning'),
            "inningState": linescore.get('inningState'),
            # Current defensive alignment (position code → player name).
            "defenseAlignment": defense_alignment,
            # Formation type: Standard / Strategic / Infield In / etc.
            "defenseFormation": defense_formation,
        }
    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Game-state parsing failed: {e}")


# ---------------------------------------------------------------------------
# Game-log endpoint
# ---------------------------------------------------------------------------


_GAME_LOG_EVENT_PHRASES = {
    'Single': 'singles',
    'Double': 'doubles',
    'Triple': 'triples',
    'Home Run': 'homers',
    'Walk': 'walks',
    'Intent Walk': 'is intentionally walked',
    'Hit By Pitch': 'is hit by pitch',
    'Strikeout': 'strikes out',
    'Flyout': 'flies out',
    'Pop Out': 'pops out',
    'Lineout': 'lines out',
    'Groundout': 'grounds out',
    'Forceout': 'grounds into a force out',
    'Double Play': 'grounds into a double play',
    'Grounded Into DP': 'grounds into a double play',
    'Triple Play': 'grounds into a triple play',
    'Sac Fly': 'hits a sacrifice fly',
    'Sac Bunt': 'lays down a sacrifice bunt',
    'Bunt Groundout': 'grounds out on a bunt',
    'Field Error': 'reaches on an error',
    'Fielders Choice': "reaches on a fielder's choice",
    'Catcher Interference': 'reaches on catcher interference',
}


def _game_log_player_name(player: dict, players: dict | None = None) -> str:
    player = player or {}
    if players and player.get('id') is not None:
        entry = players.get(f"ID{player['id']}") or players.get(str(player['id'])) or {}
        player = {**entry, **player}
    return (player.get('fullName') or player.get('lastName') or '').strip()


def _game_log_base_name(base) -> str:
    return {
        '1B': 'first',
        '2B': 'second',
        '3B': 'third',
        'home': 'home',
        'score': 'home',
    }.get(base, str(base or '').replace('B', '').lower())


def _game_log_base_ordinal(base) -> str:
    return {
        '1B': '1st',
        '2B': '2nd',
        '3B': '3rd',
        'home': 'home',
        'score': 'home',
    }.get(base, _game_log_base_name(base))


def _game_log_runner_name(runner: dict, players: dict | None = None) -> str:
    return _game_log_player_name(
        (runner.get('details') or {}).get('runner') or {},
        players,
    )


def _game_log_text_key(value: str) -> str:
    normalized = unicodedata.normalize('NFKD', str(value or ''))
    return ''.join(char for char in normalized if not unicodedata.combining(char)).casefold()


def _game_log_runner_actions(
    play: dict,
    players: dict | None = None,
    existing_description: str = '',
) -> list[str]:
    result = play.get('result') or {}
    result_event = (result.get('event') or '').strip()
    result_lower = result_event.lower()
    matchup_batter = (play.get('matchup') or {}).get('batter') or {}
    batter_id = matchup_batter.get('id')
    batter_name = _game_log_player_name(matchup_batter, players)
    batter_out = result_event in _BATTER_OUT_EVENTS
    existing_text = _game_log_text_key(existing_description)
    actions = []
    for runner in play.get('runners') or []:
        details = runner.get('details') or {}
        movement = runner.get('movement') or {}
        runner_info = details.get('runner') or {}
        runner_id = runner_info.get('id')
        name = _game_log_runner_name(runner, players)
        # The batter's result already says "Brett Bateman grounds out". The
        # feed also includes the batter's home-to-first runner movement, which
        # would otherwise append the redundant "Brett Bateman is out at first".
        # Keep outs for other runners (e.g. the runner caught stealing in a DP).
        is_batter_runner = (
            (batter_id is not None and runner_id == batter_id)
            or (batter_name and name and name.lower() == batter_name.lower())
        )
        if not name or (is_batter_runner and (batter_out or movement.get('start') is None)):
            continue
        # Result descriptions can already spell out a runner's outcome, such
        # as "Luis García Jr. out at 2nd." Do not append the same runner action
        # a second time from the structured movement data.
        if _game_log_text_key(name) in existing_text:
            continue

        end = movement.get('end')
        out_base = movement.get('outBase') or end
        detail_event = ' '.join(str(details.get(key) or '') for key in (
            'event', 'eventType', 'movementReason',
        )).lower()
        caught_stealing = 'caught stealing' in result_lower or 'caught stealing' in detail_event
        if movement.get('isOut'):
            if caught_stealing:
                actions.append(f"{name} caught stealing {_game_log_base_ordinal(out_base)}")
            else:
                actions.append(f"{name} is out at {_game_log_base_name(out_base)}" if out_base else f"{name} is out")
        elif end == 'score' or movement.get('isScoringEvent') or details.get('isScoringEvent'):
            actions.append(f"scoring {name}")
        elif end in ('1B', '2B', '3B'):
            if movement.get('start') in ('1B', '2B', '3B'):
                actions.append(f"{name} advances to {_game_log_base_name(end)}")
            else:
                actions.append(f"{name} reaches {_game_log_base_name(end)}")
    return actions


def _game_log_description(play: dict, players: dict | None = None) -> str:
    result = play.get('result') or {}
    event = (result.get('event') or '').strip()
    matchup = play.get('matchup') or {}
    batter = _game_log_player_name(matchup.get('batter') or {}, players)
    raw = (result.get('description') or '').strip()
    runner_actions = _game_log_runner_actions(play, players, raw)

    # Base-running events are often recorded as the result of a play with no
    # meaningful batter action. Use the named runner as the subject so entries
    # read "Andreas Gimenez caught stealing second", not "Unknown Player ...".
    event_lower = event.lower()
    if any(term in event_lower for term in ('stolen base', 'caught stealing', 'pickoff')):
        subject = next((action for action in runner_actions if action), None)
        if subject:
            remaining = [action for action in runner_actions if action != subject]
            return ', '.join([subject, *remaining])

    phrase = _GAME_LOG_EVENT_PHRASES.get(event)
    # Preserve the feed's extra fielding detail (for example, "P Tim Hill to
    # 1B Ben Rice"), but replace bare descriptions such as "Walk" with the
    # concise broadcast phrase.
    use_raw = raw and raw.lower() != event_lower
    if use_raw:
        if batter and not raw.lower().startswith(batter.lower()):
            raw = f"{batter} {raw[0].lower() + raw[1:]}"
        description = raw
    elif phrase and batter:
        description = f"{batter} {phrase}"
    else:
        description = raw or f"{batter} {event.lower()}".strip() or 'Play'

    return ', '.join([description, *runner_actions]) if runner_actions else description


def _game_log_score_after_play(play: dict, all_plays: list[dict], teams: dict) -> dict | None:
    """Return the score after a play when that play scored at least one run."""
    runners = play.get('runners') or []
    scored = any(
        (runner.get('movement') or {}).get('isScoringEvent')
        or (runner.get('details') or {}).get('isScoringEvent')
        or (runner.get('movement') or {}).get('end') == 'score'
        for runner in runners
    )
    if not scored:
        return None
    scores = {'away': 0, 'home': 0}
    for prior in all_plays:
        if prior is play:
            break
        side = 'away' if (prior.get('about') or {}).get('halfInning') == 'top' else 'home'
        for runner in prior.get('runners') or []:
            movement = runner.get('movement') or {}
            if movement.get('isScoringEvent') or (runner.get('details') or {}).get('isScoringEvent') or movement.get('end') == 'score':
                scores[side] += 1
    side = 'away' if (play.get('about') or {}).get('halfInning') == 'top' else 'home'
    scores[side] += sum(
        1 for runner in runners
        if (runner.get('movement') or {}).get('isScoringEvent')
        or (runner.get('details') or {}).get('isScoringEvent')
        or (runner.get('movement') or {}).get('end') == 'score'
    )
    return {
        'away': {'abbreviation': teams['away'].get('abbreviation', 'AWAY'), 'runs': scores['away']},
        'home': {'abbreviation': teams['home'].get('abbreviation', 'HOME'), 'runs': scores['home']},
        'scoring_side': side,
    }


def _game_log_play(play: dict, players: dict | None = None, score_after: dict | None = None) -> dict:
    about = play.get('about') or {}
    half = str(about.get('halfInning') or '').lower()
    inning = about.get('inning')
    return {
        "id": about.get('atBatIndex'),
        "inning": inning,
        "half_inning": 'Top' if half == 'top' else 'Bottom' if half == 'bottom' else half.title(),
        "inning_label": f"{'Top' if half == 'top' else 'Bottom' if half == 'bottom' else half.title()} {_inning_ordinal(inning)}".strip(),
        "description": _game_log_description(play, players),
        "event": (play.get('result') or {}).get('event'),
        "batter": _game_log_player_name((play.get('matchup') or {}).get('batter') or {}, players),
        "is_complete": bool(about.get('isComplete', True)),
        "score_after": score_after,
    }


@app.get("/api/game-log")
def get_game_log(game_pk: str = GAME_PK):
    """Return completed and in-progress play descriptions grouped by inning."""
    print(f"GAME LOG... Polling game {game_pk}")
    data = _fetch_feed(game_pk)
    try:
        all_plays = (data.get('liveData', {}).get('plays') or {}).get('allPlays') or []
        players = data.get('gameData', {}).get('players') or {}
        teams = data.get('gameData', {}).get('teams') or {}
        plays = [
            _game_log_play(
                play,
                players,
                _game_log_score_after_play(play, all_plays, teams),
            )
            for play in all_plays
            if (play.get('about') or {}).get('inning') is not None
        ]
        return {"success": True, "plays": plays}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Game-log parsing failed: {e}")


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
    data = _fetch_feed(game_pk)
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

        # Compute per-team RISP and hard-hit totals from the play-by-play log.
        # The standard boxscore teamStats don't expose these — they must be
        # derived by walking the allPlays list.
        all_plays = (live_data.get('plays') or {}).get('allPlays') or []
        HIT_EVENTS = {'Single', 'Double', 'Triple', 'Home Run'}
        risp = {'away': {'atBats': 0, 'hits': 0}, 'home': {'atBats': 0, 'hits': 0}}
        hard_hit = {'away': 0, 'home': 0}
        for p in all_plays:
            splits = p.get('matchup', {}).get('splits', {})
            is_risp = splits.get('menOnBase') == 'RISP'
            about = p.get('about', {})
            half = about.get('halfInning', '').lower()
            side = 'away' if 'top' in half else 'home' if 'bottom' in half else None
            if is_risp and side:
                risp[side]['atBats'] += 1
                if p.get('result', {}).get('event') in HIT_EVENTS:
                    risp[side]['hits'] += 1
            # Hard-hit ball: launchSpeed >= 95 mph from any playEvent's hitData.
            for ev in p.get('playEvents') or []:
                ls = (ev.get('hitData') or {}).get('launchSpeed')
                if isinstance(ls, (int, float)) and ls >= 95 and side:
                    hard_hit[side] += 1
                    break  # Count once per play

        result = {"success": True, "teams": {}}
        for side in ('away', 'home'):
            bt = box_teams.get(side) or {}
            game_team = (game_data.get('teams') or {}).get(side) or {}
            team_stats = bt.get('teamStats') or {}
            team_bat = team_stats.get('batting') or {}
            team_pitch = team_stats.get('pitching') or {}

            batting = []
            # The feed's batting-order list is already in lineup order and
            # includes pinch hitters. Preserve that order, then annotate an
            # incoming hitter with the starter whose lineup slot it replaced.
            lineup_by_slot = {}
            for pid in bt.get('batters') or []:
                entry = _entry(pid)
                stats = entry.get('stats', {}).get('batting') or {}
                season = entry.get('seasonStats', {}).get('batting') or {}
                slot = (entry.get('battingOrder') or '')[:2]
                if slot and slot not in lineup_by_slot:
                    lineup_by_slot[slot] = (entry.get('person') or {}).get('fullName', '—')
                batting.append({
                    "id": pid,
                    "name": (entry.get('person') or {}).get('fullName', '—'),
                    "position": (entry.get('position') or {}).get('abbreviation', ''),
                    "battingOrder": slot,
                    "ab": stats.get('atBats'),
                    "r": stats.get('runs'),
                    "h": stats.get('hits'),
                    "rbi": stats.get('rbi'),
                    "bb": stats.get('baseOnBalls'),
                    "so": stats.get('strikeOuts'),
                    "avg": season.get('avg'),
                    # Extended outcomes powering the batter's hover card. Emit
                    # the primary names the frontend reads (MLB spells the
                    # sacrifice fields ``sacFlies``/``sacBunts`` and does not
                    # list singles directly, so singles are derived).
                    "singles": max(0, (stats.get('hits') or 0)
                                   - (stats.get('doubles') or 0)
                                   - (stats.get('triples') or 0)
                                   - (stats.get('homeRuns') or 0)),
                    "doubles": stats.get('doubles'),
                    "triples": stats.get('triples'),
                    "homeRuns": stats.get('homeRuns'),
                    "hitByPitch": stats.get('hitByPitch'),
                    "stolenBases": stats.get('stolenBases'),
                    "caughtStealing": stats.get('caughtStealing'),
                    "groundedIntoDoublePlay": stats.get('groundedIntoDoublePlay'),
                    "groundedIntoTriplePlay": stats.get('groundedIntoTriplePlay'),
                    "groundOuts": stats.get('groundOuts'),
                    "flyOuts": stats.get('flyOuts'),
                    "sacrificeFlies": stats.get('sacFlies'),
                    "sacrificeBunts": stats.get('sacBunts'),
                })
            # Attach replacement metadata from play-by-play substitution
            # events. This avoids mistaking a same-slot defensive substitute
            # for a pinch hitter.
            for play in all_plays:
                for event in play.get('playEvents') or []:
                    details = event.get('details') or {}
                    if details.get('eventType') != 'offensive_substitution':
                        continue
                    new_name, old_name = _parse_sub_event(event)
                    pos_name = (event.get('position') or {}).get('name') or ''
                    description = details.get('description') or ''
                    is_hitter = 'Hitter' in pos_name or 'pinch-hitter' in description.lower()
                    if not is_hitter or not new_name or not old_name:
                        continue
                    for row in batting:
                        if row['name'] == new_name:
                            row['pinchHitterFor'] = old_name
                            break

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
                    # Extended pitching stats powering the pitcher's hover
                    # card (pitches/strikes counts and outcome details not
                    # already shown in the pitching table columns).
                    "pitchesThrown": stats.get('numberOfPitches'),
                    "strikesThrown": stats.get('strikes'),
                    "wildPitches": stats.get('wildPitches'),
                    "hitByPitch": stats.get('hitByPitch')
                        if stats.get('hitByPitch') is not None
                        else stats.get('hitBatsmen'),
                    "balks": stats.get('balks'),
                    "saves": stats.get('saves'),
                    "blownSaves": stats.get('blownSaves'),
                })

            result["teams"][side] = {
                "name": game_team.get('name') or (bt.get('team') or {}).get('name', '—'),
                "abbreviation": game_team.get('abbreviation', side.upper()),
                "batting": batting,
                "pitching": pitching,
                "teamBatting": {
                    "atBats": team_bat.get('atBats'),
                    "runs": team_bat.get('runs'),
                    "hits": team_bat.get('hits'),
                    "doubles": team_bat.get('doubles'),
                    "triples": team_bat.get('triples'),
                    "homeRuns": team_bat.get('homeRuns'),
                    "rbi": team_bat.get('rbi'),
                    "baseOnBalls": team_bat.get('baseOnBalls'),
                    "strikeOuts": team_bat.get('strikeOuts'),
                    "avg": team_bat.get('avg'),
                    "rispAtBats": risp[side]['atBats'],
                    "rispHits": risp[side]['hits'],
                    "hardHitBalls": hard_hit[side],
                },
                "teamPitching": {
                    "inningsPitched": team_pitch.get('inningsPitched'),
                    "hits": team_pitch.get('hits'),
                    "runs": team_pitch.get('runs'),
                    "earnedRuns": team_pitch.get('earnedRuns'),
                    "baseOnBalls": team_pitch.get('baseOnBalls'),
                    "strikeOuts": team_pitch.get('strikeOuts'),
                    "homeRuns": team_pitch.get('homeRuns'),
                },
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
                    "leftOnBase": ((linescore.get('teams') or {}).get(side) or {}).get('leftOnBase'),
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
    """List today's live, finished, and upcoming MLB games for the drawer."""
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

    live_games = []
    finished_games = []
    upcoming_games = []

    def summarize(game, state):
        linescore = game.get("linescore") or {}
        teams = {}
        for side in ("away", "home"):
            t = (game.get("teams") or {}).get(side, {})
            team = t.get("team", {})
            record = t.get("leagueRecord") or {}
            teams[side] = {
                "name": team.get("name", "—"),
                "abbreviation": team.get("abbreviation", side.upper()),
                "id": team.get("id"),
                "score": t.get("score"),
                "wins": record.get("wins"),
                "losses": record.get("losses"),
            }
        summary = {
            "game_pk": game.get("gamePk"),
            "game_date": game.get("gameDate"),
            "status": (game.get("status") or {}).get("detailedState") or state,
            "venue": (game.get("venue") or {}).get("name", "—"),
            "teams": teams,
            "start_time_tbd": bool((game.get("status") or {}).get("startTimeTBD")),
        }
        if state in ("Live", "Final"):
            inn_state = linescore.get("inningState")
            if state == "Final" and inn_state not in ("Middle", "End"):
                inn_state = "End"
            summary["inning"] = {
                "number": linescore.get("currentInning"),
                "ordinal": linescore.get("currentInningOrdinal"),
                "isTop": linescore.get("isTopInning"),
                "state": inn_state,
            }
            summary["innings"] = linescore.get("currentInning")
        return summary

    for date_block in data.get("dates", []):
        for game in date_block.get("games", []):
            state = (game.get("status") or {}).get("abstractGameState")
            if state == "Live":
                live_games.append(summarize(game, state))
            elif state == "Preview":
                upcoming_games.append(summarize(game, state))
            elif state == "Final":
                finished_games.append(summarize(game, state))

    # Upcoming games read like a schedule: soonest first.
    upcoming_games.sort(key=lambda g: g.get("game_date") or "")
    finished_games.sort(key=lambda g: g.get("game_date") or "")

    return {"success": True, "games": live_games, "finished": finished_games, "upcoming": upcoming_games}


# ── League-average pitch break (Baseball Savant Statcast CSV) ─────────────────
# League-average induced break by pitch type and pitcher hand, aggregated from
# Baseball Savant's statcast_search CSV export
# (https://baseballsavant.mlb.com/csv-docs). The CSV returns per-pitch rows
# with pfx_x/pfx_z in FEET, already in the fixed Statcast convention the rest
# of the app uses (positive pfx_x = break toward first base for BOTH hands,
# positive pfx_z = upward IVB) — so no handedness mirroring is applied here,
# matching the live-feed payload and the pitcher-movement graph. Because
# horizontal break is the mirror image across hands (a LHP sinker breaks
# +17 in toward 1B where a RHP's breaks -17 in), the averages are bucketed per
# pitcher hand so pooling both hands doesn't cancel H Break toward zero. Values
# are converted to inches and cached for a few hours so the frontend's H Break /
# IVB comparison rows don't hammer Savant on every load. The window is short
# enough to stay light (each daily request is a few thousand pitches, well
# under Savant's 25k-row CSV cap).
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


def _aggregate_break_averages(rows) -> dict:
    """Aggregate mean pfx_x/pfx_z (inches) by pitch type and pitcher hand.

    ``rows`` are Savant statcast CSV rows (see ``_savant_day_rows``) whose
    pfx_x/pfx_z are in FEET, in the fixed Statcast convention (positive pfx_x
    = break toward first base for both hands, positive pfx_z = upward IVB).
    No sign mirroring is applied — each hand's values are stored under its
    ``p_throws`` code (``R``/``L``), and buckets with fewer than 25 pitches
    are dropped so tiny samples don't skew the average.
    """
    sums = {}  # (pitch_type, hand) -> [count, sum_x, sum_z]
    for row in rows:
        pitch_type = (row.get("pitch_type") or "").strip()
        hand = (row.get("p_throws") or "").strip().upper()
        if not pitch_type or hand not in ("R", "L"):
            continue
        try:
            # Savant's CSV exports pfx in feet; the app displays inches.
            x = float(row["pfx_x"]) * 12.0
            z = float(row["pfx_z"]) * 12.0
        except (KeyError, TypeError, ValueError):
            continue
        acc = sums.setdefault((pitch_type, hand), [0, 0.0, 0.0])
        acc[0] += 1
        acc[1] += x
        acc[2] += z

    averages = {}
    for (pitch_type, hand), (n, sum_x, sum_z) in sums.items():
        if n >= 25:  # skip tiny samples
            averages.setdefault(pitch_type, {})[hand] = {
                "x": round(sum_x / n, 2),
                "z": round(sum_z / n, 2),
                "n": n,
            }
    return averages


def _fetch_break_averages():
    """Fetch + aggregate mean pfx_x/pfx_z (inches) by pitch type and hand."""
    today = datetime.now(timezone.utc).date()
    days = [today - timedelta(days=i) for i in range(BREAK_AVERAGES_WINDOW_DAYS)]
    rows = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(_savant_day_rows, day) for day in days]
        for future in futures:
            try:
                rows.extend(future.result())
            except Exception:
                # A failed day shouldn't sink the whole average.
                continue
    return _aggregate_break_averages(rows)


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

# After a failed grid build, wait this long before spawning another rebuild
# thread. Without a backoff the ``building`` flag re-arms the moment a build
# fails, so a down Savant makes every rapid poll spawn a fresh ~1-minute
# rebuild (each fanning out to 4 worker fetches).
_XBA_GRID_REBUILD_COOLDOWN_SECONDS = 60

_xba_grid_lock = threading.Lock()
_xba_grid_cache = {
    "fetched_at": 0.0,
    "grid": None,
    "building": False,
    "next_attempt_at": 0.0,
}

# After a failed (or empty) Sprint-Speed fetch, wait this long before the next
# attempt. Without a backoff a down Savant would make every rapid poll spawn a
# fresh synchronous fetch, mirroring the xBA-grid rebuild storm.
_SPRINT_SPEED_REBUILD_COOLDOWN_SECONDS = 60

_sprint_speed_lock = threading.Lock()
_sprint_speed_cache = {
    "fetched_at": 0.0,
    "by_player": {},
    "building": False,
    "next_attempt_at": 0.0,
}
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
    is None and xBA simply shows a dash. Rebuilds are single-flighted: the
    ``building`` flag is checked and armed under ``_xba_grid_lock``, so a burst
    of rapid polls (trajectory + batted-ball + game-state all warm the grid)
    can only ever start one rebuild thread at a time. A failed build backs off
    for ``_XBA_GRID_REBUILD_COOLDOWN_SECONDS`` instead of immediately re-arming
    the flag, so a Savant outage can't turn each poll into a new overlapping
    ~4-worker scrape.
    """
    now = time.time()
    with _xba_grid_lock:
        if (_xba_grid_cache["grid"] is not None
                and now - _xba_grid_cache["fetched_at"] < _XBA_GRID_TTL_SECONDS):
            return _xba_grid_cache["grid"]
        if (not _xba_grid_cache["building"]
                and now >= _xba_grid_cache.get("next_attempt_at", 0.0)):
            _xba_grid_cache["building"] = True

            def _rebuild():
                try:
                    grid = _build_xba_grid()
                    with _xba_grid_lock:
                        _xba_grid_cache["grid"] = grid
                        _xba_grid_cache["fetched_at"] = time.time()
                    print(f"[xBA] grid rebuilt — {np.isfinite(grid).sum():,}/{grid.size:,} valid cells")
                except Exception as e:
                    # Back off before the next attempt so rapid polls can't
                    # each re-spawn a rebuild while Savant is down.
                    with _xba_grid_lock:
                        _xba_grid_cache["next_attempt_at"] = (
                            time.time() + _XBA_GRID_REBUILD_COOLDOWN_SECONDS
                        )
                    print(f"[xBA] grid build failed: {e}")
                finally:
                    with _xba_grid_lock:
                        _xba_grid_cache["building"] = False

            threading.Thread(target=_rebuild, daemon=True).start()
        return _xba_grid_cache["grid"]


def _sprint_speed_by_player():
    """Return {player_id: sprint_speed} from Savant's leaderboard, cached.

    Same treatment as ``_xba_grid``: the first fetch runs in a background
    thread so a cold poll isn't blocked for the Savant round-trip; until it
    completes callers get the (possibly stale) cache, and a missing speed just
    falls back to the league-average ground-ball slope in ``_compute_xba``.
    The fetch is single-flighted (the ``building`` flag arms under
    ``_sprint_speed_lock`` before the thread spawns, so concurrent polls share
    one request) and a failed or empty fetch backs off for
    ``_SPRINT_SPEED_REBUILD_COOLDOWN_SECONDS`` so a Savant outage can't spawn
    a new fetch on every poll.
    """
    now = time.time()
    with _sprint_speed_lock:
        if (_sprint_speed_cache["by_player"]
                and now - _sprint_speed_cache["fetched_at"] < _SPRINT_SPEED_TTL_SECONDS):
            return _sprint_speed_cache["by_player"]
        if (not _sprint_speed_cache["building"]
                and now >= _sprint_speed_cache.get("next_attempt_at", 0.0)):
            _sprint_speed_cache["building"] = True

            def _rebuild():
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
                    if not by_player:
                        raise ValueError("no sprint-speed rows in response")
                    with _sprint_speed_lock:
                        _sprint_speed_cache["by_player"] = by_player
                        _sprint_speed_cache["fetched_at"] = time.time()
                    print(f"[sprint-speed] loaded {len(by_player):,} players")
                except Exception as e:
                    # Back off before the next attempt so rapid polls can't
                    # each re-spawn a fetch while Savant is down/empty.
                    with _sprint_speed_lock:
                        _sprint_speed_cache["next_attempt_at"] = (
                            time.time() + _SPRINT_SPEED_REBUILD_COOLDOWN_SECONDS
                        )
                    print(f"[sprint-speed] fetch failed: {e}")
                finally:
                    with _sprint_speed_lock:
                        _sprint_speed_cache["building"] = False

            threading.Thread(target=_rebuild, daemon=True).start()
        return _sprint_speed_cache["by_player"]


def _sprint_speed_for_batter(batter_id):
    """Return a batter's sprint speed (ft/s), or None when unknown."""
    if batter_id is None:
        return None
    return _sprint_speed_by_player().get(str(batter_id))


def _refresh_xba_in_place(payload):
    """Recompute xBA for a cached response so a warm grid replaces stale None."""
    def _refresh_one(p):
        bb = p.get("batted_ball") or {}
        ls = bb.get("launch_speed") or p.get("launch_speed")
        la = bb.get("launch_angle") or p.get("launch_angle")
        bid = p.get("batter_id")
        sprint = _sprint_speed_for_batter(bid) if bid else None
        new_xba = _compute_xba(ls, la, sprint)
        if new_xba is not None:
            p["xba"] = new_xba
            if bb:
                bb["xba"] = new_xba

    _refresh_one(payload)
    for qt in (payload.get("queued_trajectories") or
               payload.get("queued_batted_balls") or []):
        _refresh_one(qt)


def _compute_xba(launch_speed, launch_angle, sprint_speed=None):
    """Compute xBA from exit velocity, launch angle, and (on ground balls) sprint speed.

    Uses bilinear interpolation across the 4 surrounding EV/LA bins for sub-bin
    accuracy (vs. snapping to the nearest bin).  Values outside the grid bounds
    are clamped to the edge cells instead of returning None, and NaN bins fall
    back to a weighted mean of their valid neighbours.

    Returns a rounded probability in [0.02, 0.99], or None only when the grid
    is completely unavailable so the frontend shows a dash.

    Validated on a 5-day holdout (Aug 2025) against Savant's ``estimated_ba_using_speedangle``:
    ― r: 0.9776 (old nearest-neighbour: 0.9740)
    ― MAE: 0.047 (old: 0.049, -5 %)
    ― Coverage: 1,962 batted balls scored (old: 1,894, +3.6 %) thanks to edge
      clamping + NaN fallback.
    """
    # Kick off the grid build eagerly so that even a non-contact pitch
    # warms the cache; the call itself returns immediately and the build
    # runs in a background thread.
    grid = _xba_grid()
    if launch_speed is None or launch_angle is None:
        return None
    try:
        ev = float(launch_speed)
        la = float(launch_angle)
    except (TypeError, ValueError):
        return None
    if grid is None:
        return None

    # ── Bilinear interpolation across the 4 surrounding cells ────────────
    # Clamp to grid bounds instead of rejecting values near the edge.
    ev_frac = (ev - _XBA_EV_MIN) / _XBA_EV_STEP
    la_frac = (la - _XBA_LA_MIN) / _XBA_LA_STEP
    ev_frac_clamped = min(max(ev_frac, 0.0), grid.shape[1] - 1.001)
    la_frac_clamped = min(max(la_frac, 0.0), grid.shape[0] - 1.001)

    ev0 = int(ev_frac_clamped)
    la0 = int(la_frac_clamped)
    ev1 = min(ev0 + 1, grid.shape[1] - 1)
    la1 = min(la0 + 1, grid.shape[0] - 1)

    ev_w = ev_frac_clamped - ev0  # weight for ev1 (cols)
    la_w = la_frac_clamped - la0  # weight for la1 (rows)

    corners = [
        grid[la0, ev0],
        grid[la0, ev1],
        grid[la1, ev0],
        grid[la1, ev1],
    ]
    weights = [
        (1 - ev_w) * (1 - la_w),
        ev_w * (1 - la_w),
        (1 - ev_w) * la_w,
        ev_w * la_w,
    ]

    # Fall back to the weighted mean of valid corners when some are NaN (sparse
    # bins), and only give up when every corner is NaN.
    valid_weight = 0.0
    xba = 0.0
    for v, w in zip(corners, weights):
        if not math.isnan(v):
            xba += v * w
            valid_weight += w
    if valid_weight == 0.0:
        return None
    xba /= valid_weight

    if sprint_speed is not None:
        # Sprint speed matters most on ground balls and diminishes toward
        # liners.  An exponential decay blends the adjustment to zero by ~10°
        # so there is no hard discontinuity.
        weight = math.exp(-la / 3.0) if la > 0 else 1.0
        xba += _XBA_SPRINT_GROUND_SLOPE * (sprint_speed - _XBA_SPRINT_LEAGUE_AVG) * weight
    return round(min(max(xba, 0.02), 0.99), 3)


@app.get("/api/break-averages")
def get_break_averages():
    """League-average induced break (inches) by pitch type and pitcher hand,
    from Baseball Savant. H Break / IVB are in the fixed Statcast convention
    (positive H Break = toward 1B, positive IVB = upward) so they match the
    pitch panel's pfx_x/pfx_z and the movement graph."""
    averages = _get_cached_break_averages()
    return {
        "success": True,
        "season": datetime.now(timezone.utc).year,
        "window_days": BREAK_AVERAGES_WINDOW_DAYS,
        "averages": averages,
    }


# ── Pitcher Movement Graph ──────────────────────────────────────────────────
# Per-pitcher pitch movement data from Baseball Savant, grouped by pitch type
# with 95% confidence ellipse parameters so the frontend can draw the pitch
# movement scatterplot (H Break vs V Break) with covariance ellipses.
_PITCHER_MOVEMENT_WINDOW_DAYS = 60  # pull ~2 months of pitches per pitcher
_PITCHER_MOVEMENT_CACHE_TTL = 6 * 60 * 60  # 6 hours

_pitcher_movement_lock = threading.Lock()
_pitcher_movement_cache = {}  # (pitcher_id, year) -> {"fetched_at": float, "data": dict}


def _fetch_pitcher_movement(pitcher_id: int, year: int) -> dict:
    """Query Baseball Savant CSV for a pitcher's recent pitches, grouped by
    pitch type, with per-group covariance ellipse parameters for the frontend's
    pitch movement scatterplot. Uses a single broad date-range query to avoid
    firing 60 parallel requests.

    The CSV's pfx_x/pfx_z are kept AS-IS (feet converted to inches). They use
    the same fixed Statcast convention as the live feed's breaks object and
    the Savant game feed: positive pfx_x = break toward first base (catcher's
    right), positive pfx_z = upward IVB. No LHP mirroring, so the ellipses and
    the current-pitch dot share one convention for both hands.
    """
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=_PITCHER_MOVEMENT_WINDOW_DAYS)
    date_start = start.strftime("%Y-%m-%d")
    date_end = today.strftime("%Y-%m-%d")
    url = (
        "https://baseballsavant.mlb.com/statcast_search/csv"
        f"?all=true&type=details&player_type=pitcher"
        f"&pitchers_lookup%5B%5D={pitcher_id}"
        f"&hfSea={year}%7C"
        f"&game_date_gt={date_start}&game_date_lt={date_end}"
    )

    points_by_type = {}  # pitch_type -> [(h_break, v_break), ...]
    try:
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        rows = list(csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig"))))
        for row in rows:
            pitch_type = (row.get("pitch_type") or "").strip()
            if not pitch_type:
                continue
            try:
                h_break = float(row["pfx_x"]) * 12.0  # feet → inches
                v_break = float(row["pfx_z"]) * 12.0
            except (KeyError, TypeError, ValueError):
                continue
            points_by_type.setdefault(pitch_type, []).append((h_break, v_break))
    except Exception:
        # A failed fetch shouldn't crash the endpoint; return empty.
        pass

    return _compute_ellipse_params(points_by_type)


def _compute_ellipse_params(points_by_type: dict) -> dict:
    result = {}
    for pitch_type, pts in points_by_type.items():
        if len(pts) < 5:  # skip tiny samples
            continue
        xs = [p[0] for p in pts]
        zs = [p[1] for p in pts]
        n = len(pts)
        mean_x = sum(xs) / n
        mean_z = sum(zs) / n

        # Covariance matrix
        cov_xx = sum((x - mean_x) ** 2 for x in xs) / (n - 1)
        cov_zz = sum((z - mean_z) ** 2 for z in zs) / (n - 1)
        cov_xz = sum((x - mean_x) * (z - mean_z) for x, z in zip(xs, zs)) / (n - 1)

        # Eigen decomposition for ellipse axes
        # 2x2 symmetric matrix [[cov_xx, cov_xz], [cov_xz, cov_zz]]
        trace = cov_xx + cov_zz
        det = cov_xx * cov_zz - cov_xz * cov_xz
        if det <= 0:
            continue
        # Eigenvalues (largest first)
        disc = max(trace * trace - 4 * det, 0)
        lambda1 = (trace + math.sqrt(disc)) / 2
        lambda2 = (trace - math.sqrt(disc)) / 2
        if lambda1 <= 0 or lambda2 <= 0:
            continue

        # 95% confidence ellipse scaling: chi-squared with 2 df at p=0.95 ≈ 5.991
        chi2_95 = 5.991
        a = math.sqrt(chi2_95 * lambda1)  # semi-major axis
        b = math.sqrt(chi2_95 * lambda2)  # semi-minor axis

        # Angle of the major axis (from eigenvector of lambda1)
        # For cov_xz != 0: eigenvector is [cov_xz, lambda1 - cov_xx]
        if abs(cov_xz) > 1e-10:
            angle = math.atan2(lambda1 - cov_xx, cov_xz)
        else:
            angle = 0.0 if cov_xx >= cov_zz else math.pi / 2

        result[pitch_type] = {
            "n": n,
            "center_x": round(mean_x, 2),
            "center_z": round(mean_z, 2),
            "a": round(a, 2),  # semi-major axis (in)
            "b": round(b, 2),  # semi-minor axis (in)
            "angle": round(angle, 4),  # radians
        }

    return result


@app.get("/api/pitcher-movement")
def get_pitcher_movement(pitcher_id: int, year: Optional[int] = None):
    """Pitch movement scatter data (H Break vs V Break) for a specific pitcher,
    grouped by pitch type with 95% confidence ellipse parameters.

    Queries Baseball Savant's CSV export for the last 60 days of the given
    season (defaults to the current year). Values keep Statcast's fixed sign
    convention (positive pfx_x = toward 1B / catcher's right) matching the
    Savant game feed for both hands.
    """
    if year is None:
        year = datetime.now(timezone.utc).year

    cache_key = (pitcher_id, year)
    now = time.time()

    with _pitcher_movement_lock:
        entry = _pitcher_movement_cache.get(cache_key)
        if entry and now - entry["fetched_at"] < _PITCHER_MOVEMENT_CACHE_TTL:
            return {"success": True, "data": entry["data"]}

    try:
        data = _fetch_pitcher_movement(pitcher_id, year)
        with _pitcher_movement_lock:
            _pitcher_movement_cache[cache_key] = {"fetched_at": time.time(), "data": data}
        return {"success": True, "data": data}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch pitcher movement data: {e}")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
