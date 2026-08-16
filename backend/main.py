import os
import sys
import math
from datetime import datetime
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

# Using the placeholder gamePk
GAME_PK = '822777'
URL = f"https://statsapi.mlb.com/api/v1.1/game/{GAME_PK}/feed/live"

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


def _build_trajectory_payload(data: dict, env: EnvironmentParameters, env_meta: dict) -> dict:
    """
    Internal helper: given the raw MLB live-feed JSON and resolved environment
    params, run the physics simulation and return the full payload dict.
    Extracted so both /api/trajectory and /api/trajectory/compare can share it.
    """
    all_plays = data['liveData']['plays']['allPlays']
    if not all_plays:
        raise HTTPException(status_code=404, detail="Game hasn't started yet!")

    last_play = all_plays[-1]
    play_events = last_play.get('playEvents', [])
    pitches = [event for event in play_events if event.get('isPitch')]
    if not pitches:
        raise HTTPException(status_code=404, detail="No pitches thrown yet in this at-bat.")

    last_pitch = pitches[-1]
    parsed = _pitch_parameters_from_event(
        last_play, last_pitch, air_density_kg_m3=_air_density_from_env(env)
    )
    pitch = parsed["pitch"]
    sim_params = parsed["sim_params"]

    pitch_data = last_pitch.get('pitchData', {})
    coordinates = pitch_data.get('coordinates', {})

    pitcher_id = last_play.get('matchup', {}).get('pitcher', {}).get('id')
    pitch_type_code = last_pitch.get('details', {}).get('type', {}).get('code', 'FF')

    sim = FullBallTrajectorySimulator(integration_method=IntegrationMethod.RK4)
    sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)

    pitcher = last_play.get('matchup', {}).get('pitcher', {}).get('fullName', 'N/A')
    start_speed = pitch_data.get('startSpeed', 0)
    game_date = data.get('gameData', {}).get('datetime', {}).get('officialDate', 'Unknown Date')
    total_pitches = sum(
        1 for play in all_plays
        if play.get('matchup', {}).get('pitcher', {}).get('id') == pitcher_id
        for event in play.get('playEvents', []) if event.get('isPitch')
    )

    sz_top, sz_bottom = 3.5, 1.5
    for event in last_play.get('playEvents', []):
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
        "pitcher": pitcher,
        "pitch_type": pitch_type_code,
        "speed_mph": start_speed,
        "game_date": game_date,
        "total_pitches": total_pitches,
        "strike_zone_top": sz_top,
        "strike_zone_bottom": sz_bottom,
        "statcast_px": statcast_px,
        "statcast_pz": statcast_pz,
        "statcast_px_mid": px_mid,
        "statcast_pz_mid": pz_mid,
        "spin_efficiency":  sim_params.get('spin_efficiency'),
        "active_spin_rpm": math.sqrt(
            sim_params.get('backspin_rpm', 0.0) ** 2 +
            sim_params.get('sidespin_rpm', 0.0) ** 2
        ),
        "sim_params": sim_params,
        "environment": env_meta,
        "trajectory": sim.trajectory,
        "quadratic_trajectory": quadratic_trajectory,
    }


@app.get("/api/trajectory")
def get_trajectory(env: str = "live"):
    """Return a single trajectory simulation.

    Query params
    ------------
    env : "live" (default) | "default"
        "live"    – pull weather/elevation from the MLB Stats API game feed.
        "default" – use neutral baseline conditions (70 °F, 15 ft elev, 50 % RH).
    """
    print(f"LOADING LEVEL... Polling game {GAME_PK} (env={env})")
    response = requests.get(URL)
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch from MLB API")
    data = response.json()
    try:
        if env == "default":
            resolved_env, env_meta = DEFAULT_ENV, DEFAULT_ENV_META
        else:
            resolved_env, env_meta = fetch_environment_params(data.get('gameData', {}))
        return _build_trajectory_payload(data, resolved_env, env_meta)
    except HTTPException:
        raise
    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Simulation failed: {e}")


@app.get("/api/trajectory/compare")
def get_trajectory_compare():
    """Return both live-weather and default-environment trajectories in one
    response so the frontend can overlay them for visual comparison.

    Response keys
    -------------
    live    – trajectory simulated with real game weather/elevation.
    default – trajectory simulated with neutral MLB baseline conditions.
    """
    print(f"COMPARE MODE... Polling game {GAME_PK}")
    response = requests.get(URL)
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch from MLB API")
    data = response.json()
    try:
        live_env, live_meta   = fetch_environment_params(data.get('gameData', {}))
        live_payload    = _build_trajectory_payload(data, live_env, live_meta)
        default_payload = _build_trajectory_payload(data, DEFAULT_ENV, DEFAULT_ENV_META)
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

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
