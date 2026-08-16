import os
import sys
import unittest
import math

parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sim_dir = os.path.join(parent_dir, "skill-vis:MyTrajectorySimulator-main")
sys.path.insert(0, sim_dir)
sys.path.insert(0, os.path.join(sim_dir, "API"))

from MyBallTrajectorySim import PitchParameters, EnvironmentParameters, IntegrationMethod
from statcast_to_sim import statcast_to_sim_params
from backend.main import FullBallTrajectorySimulator


class TestTrajectorySimulationAccuracy(unittest.TestCase):
    """
    Unit test suite verifying trajectory simulation accuracy,
    release backpropagation, and full plate integration.
    """

    def setUp(self):
        # Erick Fedde Sinker data from MLB live feed (Game 824729)
        self.coords = {
            'x0': -1.0122211576705065,
            'y0': 50.00302055999216,
            'z0': 5.792827868168868,
            'vX0': 5.669957565356303,
            'vY0': -135.24874824646648,
            'vZ0': -5.9231393261809675,
            'aX': -8.348431147475099,
            'aY': 28.27196942125816,
            'aZ': -22.88661710324329,
            'pfxX': -4.486107890654716,
            'pfxZ': 4.990726258706874,
            'pX': 0.5241553292937348,
            'pZ': 1.9793071320834879,
        }
        self.breaks = {
            'spinRate': 2170,
            'spinDirection': 199,
        }
        self.extension = 6.0

    def test_release_backpropagation_and_crossing_accuracy(self):
        x0_50 = self.coords['x0']
        y0_50 = self.coords['y0']
        z0_50 = self.coords['z0']
        vx0_50 = self.coords['vX0']
        vy0_50 = self.coords['vY0']
        vz0_50 = self.coords['vZ0']
        ax = self.coords['aX']
        ay = self.coords['aY']
        az = self.coords['aZ']

        release_ext = self.extension
        y_rel = 60.5 - release_ext
        vyR = -math.sqrt(max(0.0, vy0_50**2 + 2 * ay * (y_rel - y0_50)))
        tR = (vyR - vy0_50) / ay
        x_rel = x0_50 + vx0_50 * tR + 0.5 * ax * tR**2
        z_rel = z0_50 + vz0_50 * tR + 0.5 * az * tR**2

        statcast_data = {
            "release_pos_x": x_rel,
            "release_extension": release_ext,
            "release_pos_z": z_rel,
            "vx0": vx0_50,
            "vy0": vy0_50,
            "vz0": vz0_50,
            "ax": ax,
            "ay": ay,
            "az": az,
            "pfx_x": float(self.coords['pfxX']) / 12.0,
            "pfx_z": float(self.coords['pfxZ']) / 12.0,
            "release_spin_rate": self.breaks['spinRate'],
            "spin_axis": self.breaks['spinDirection'],
            "pitch_type": "SI",
            "p_throws": "R",
        }

        sim_params = statcast_to_sim_params(statcast_data, spin_method="bsg", accel_method=True)
        valid_keys = ['x0', 'y0', 'z0', 'v0_mps', 'theta_deg', 'phi_deg',
                      'backspin_rpm', 'sidespin_rpm', 'wg_rpm', 'batter_hand']
        pitch_kwargs = {k: v for k, v in sim_params.items() if k in valid_keys}
        pitch_kwargs['batter_hand'] = 'R'

        pitch = PitchParameters(**pitch_kwargs)
        sim = FullBallTrajectorySimulator(integration_method=IntegrationMethod.RK4)
        traj = sim.simulate(pitch=pitch)

        # 1. Trajectory must span through y <= 0.0m (past home plate)
        self.assertGreater(len(traj), 100)
        self.assertGreater(traj[0]['y'], 15.0)
        self.assertLessEqual(traj[-1]['y'], 0.0)

        # 2. Both front and mid plate crossings must be computed
        self.assertIsNotNone(sim.home_plate_crossing_front)
        self.assertIsNotNone(sim.home_plate_crossing_mid)

        # 3. Accuracy check: crossing error against Statcast pX, pZ must be within 2 inches
        sim_front_x_ft = sim.home_plate_crossing_front['x'] / 0.3048
        sim_front_z_ft = sim.home_plate_crossing_front['z'] / 0.3048
        err_front_in = math.sqrt((sim_front_x_ft - self.coords['pX'])**2 +
                                 (sim_front_z_ft - self.coords['pZ'])**2) * 12.0

        self.assertLess(err_front_in, 2.0,
                        f"Front plate error {err_front_in:.2f} inches exceeds 2.0 inch tolerance")


if __name__ == '__main__':
    unittest.main()
