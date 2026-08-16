"""Shared multi-venue game set for the trajectory-model sweeps.

A fixed list of completed 2025 MLB games, one per venue, chosen to span the
league's elevation (0-5190 ft), game-time temperature (54-86 F), and roof
diversity (open, retractable, and roof-closed). ``test_weather_accuracy_multi``,
``fit_calibration`` and ``fit_sidespin_scale`` all read this list, so the A/B
weather comparison and both calibration fits are evaluated on the same sample
rather than three drifting copies.

Each tuple is (gamePk, venue, elevation_ft, roof_type, condition, temp_F).
"""

VENUE_GAMES = [
    (777616, "Coors Field",                   5190, "Open",        "Partly Cloudy", 54),
    (777679, "Chase Field",                   1086, "Retractable", "Roof Closed",  76),
    (777692, "Truist Park",                   1001, "Open",        "Partly Cloudy", 77),
    (777677, "Kauffman Stadium",               856, "Open",        "Partly Cloudy", 84),
    (777615, "Target Field",                   828, "Open",        "Partly Cloudy", 71),
    (777663, "PNC Park",                       780, "Open",        "Clear",        83),
    (777683, "Progressive Field",              653, "Open",        "Partly Cloudy", 58),
    (777626, "Comerica Park",                  600, "Open",        "Partly Cloudy", 72),
    (777617, "American Family Field",          597, "Retractable", "Clear",        70),
    (777674, "Rate Field",                     595, "Open",        "Partly Cloudy", 84),
    (777687, "Wrigley Field",                  595, "Open",        "Sunny",        59),
    (777678, "Globe Life Field",               545, "Retractable", "Roof Closed",  74),
    (777671, "Great American Ball Park",       535, "Open",        "Clear",        77),
    (777682, "Dodger Stadium",                 515, "Open",        "Cloudy",       81),
    (777660, "Busch Stadium",                  460, "Open",        "Clear",        86),
    (777685, "Rogers Centre",                  270, "Retractable", "Roof Closed",  68),
    (777614, "Angel Stadium",                  151, "Open",        "Partly Cloudy", 70),
    (777664, "Yankee Stadium",                  55, "Open",        "Clear",        74),
    (777690, "Daikin Park",                     45, "Retractable", "Roof Closed",  73),
    (777659, "Nationals Park",                  35, "Open",        "Clear",        81),
    (777662, "George M. Steinbrenner Field",    34, "Open",        "Cloudy",       78),
    (777684, "Oriole Park at Camden Yards",     33, "Open",        "Sunny",        70),
    (777669, "Sutter Health Park",              24, "Open",        "Clear",        78),
    (777681, "Petco Park",                      23, "Open",        "Overcast",     72),
    (777670, "Fenway Park",                     21, "Open",        "Partly Cloudy", 70),
    (777688, "Citizens Bank Park",              20, "Open",        "Partly Cloudy", 68),
    (777686, "Citi Field",                      10, "Open",        "Partly Cloudy", 64),
    (777680, "T-Mobile Park",                   10, "Retractable", "Partly Cloudy", 63),
    (777689, "loanDepot park",                  10, "Retractable", "Roof Closed",  72),
    (777676, "Oracle Park",                      0, "Open",        "Partly Cloudy", 60),
]

# The flat gamePk list the sweep scripts iterate over.
DEFAULT_GAME_PKS = [g[0] for g in VENUE_GAMES]
