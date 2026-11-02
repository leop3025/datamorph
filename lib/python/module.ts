// Python source executed once inside Pyodide. `dispatch(name, args_json)` is the only entry point.
// Kept as a TS string so it ships with the app bundle and needs no extra request.

import { PY_ML } from "./ml";

const PY_CORE = String.raw`
import json, math, warnings
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
_frames = {}

def clean(o):
    """Make numpy/pandas values JSON-safe (NaN/inf -> None)."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return [clean(v) for v in o.tolist()]
    if isinstance(o, (np.bool_, bool)):
        return bool(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(o, (pd.Timestamp,)):
        return o.isoformat()
    return o

def load(a):
    key = a["path"]
    if a.get("fresh") or key not in _frames:
        _frames[key] = pd.read_csv(key, parse_dates=a.get("dates") or [])
    return _frames[key]

def dispatch(name, args_json):
    args = json.loads(args_json)
    return json.dumps(clean(FUNCS[name](args)))

FUNCS = {}
def fn(f):
    FUNCS[f.__name__] = f
    return f
`;

const PY_STATS = String.raw`
from scipy import stats as st

def _groups(df, value, group, levels=None, limit=20):
    d = df[[value, group]].dropna()
    d[group] = d[group].astype(str)
    if levels is None:
        levels = d[group].value_counts().index[:limit].tolist()
    return [(g, d.loc[d[group] == g, value].astype(float).values) for g in levels]

def _summ(name, x):
    return {"group": name, "n": len(x), "mean": float(np.mean(x)) if len(x) else None,
            "median": float(np.median(x)) if len(x) else None, "std": float(np.std(x, ddof=1)) if len(x) > 1 else None}

def _normal(x):
    if len(x) < 3:
        return None
    return float(st.shapiro(x[:5000]).pvalue)

@fn
def ttest(a):
    df = load(a)
    (g1, x), (g2, y) = _groups(df, a["value"], a["group"], a["levels"])
    if len(x) < 2 or len(y) < 2:
        raise ValueError("Each group needs at least 2 values.")
    t = st.ttest_ind(x, y, equal_var=False)
    sp = math.sqrt(((len(x) - 1) * np.var(x, ddof=1) + (len(y) - 1) * np.var(y, ddof=1)) / (len(x) + len(y) - 2))
    mw = st.mannwhitneyu(x, y, alternative="two-sided")
    return {
        "test": "Welch's t-test", "statistic": t.statistic, "p": t.pvalue, "df": t.df,
        "effect": {"name": "Cohen's d", "value": (np.mean(x) - np.mean(y)) / sp if sp else None},
        "groups": [_summ(g1, x), _summ(g2, y)],
        "alternative": {"test": "Mann-Whitney U", "statistic": mw.statistic, "p": mw.pvalue},
        "checks": {"normal_p": [_normal(x), _normal(y)], "levene_p": st.levene(x, y).pvalue},
    }

@fn
def anova(a):
    df = load(a)
    groups = [(g, x) for g, x in _groups(df, a["value"], a["group"]) if len(x) >= 2]
    if len(groups) < 2:
        raise ValueError("Need at least two groups with 2+ values.")
    xs = [x for _, x in groups]
    f = st.f_oneway(*xs)
    allx = np.concatenate(xs)
    ssb = sum(len(x) * (np.mean(x) - allx.mean()) ** 2 for x in xs)
    sst = ((allx - allx.mean()) ** 2).sum()
    kw = st.kruskal(*xs)
    return {
        "test": "One-way ANOVA", "statistic": f.statistic, "p": f.pvalue, "df": [len(xs) - 1, len(allx) - len(xs)],
        "effect": {"name": "eta squared", "value": ssb / sst if sst else None},
        "groups": [_summ(g, x) for g, x in groups],
        "alternative": {"test": "Kruskal-Wallis H", "statistic": kw.statistic, "p": kw.pvalue},
        "checks": {"levene_p": st.levene(*xs).pvalue},
    }

@fn
def chisquare(a):
    df = load(a)
    d = df[[a["a"], a["b"]]].dropna().astype(str)
    top_a = d[a["a"]].value_counts().index[:20]
    top_b = d[a["b"]].value_counts().index[:20]
    d = d[d[a["a"]].isin(top_a) & d[a["b"]].isin(top_b)]
    table = pd.crosstab(d[a["a"]], d[a["b"]])
    if table.shape[0] < 2 or table.shape[1] < 2:
        raise ValueError("Both columns need at least two values.")
    chi2, p, dof, expected = st.chi2_contingency(table)
    n = table.values.sum()
    v = math.sqrt(chi2 / (n * (min(table.shape) - 1)))
    return {
        "test": "Chi-square test of independence", "statistic": chi2, "p": p, "df": dof,
        "effect": {"name": "Cramér's V", "value": v},
        "table": {"rows": table.index.tolist(), "cols": table.columns.tolist(), "values": table.values.tolist(),
                  "row_pct": (table.div(table.sum(axis=1), axis=0) * 100).round(1).values.tolist()},
        "checks": {"low_expected_share": float((expected < 5).mean())},
        "n": n,
    }

@fn
def correlation(a):
    df = load(a)
    d = df[[a["x"], a["y"]]].dropna().astype(float)
    if len(d) < 3:
        raise ValueError("Need at least 3 rows with both values.")
    x, y = d[a["x"]].values, d[a["y"]].values
    pr = st.pearsonr(x, y)
    sr = st.spearmanr(x, y)
    lr = st.linregress(x, y)
    idx = np.random.default_rng(0).choice(len(d), size=min(len(d), 1500), replace=False)
    main = pr if a.get("method", "pearson") == "pearson" else sr
    return {
        "test": "Pearson correlation" if a.get("method", "pearson") == "pearson" else "Spearman rank correlation",
        "statistic": main.statistic, "p": main.pvalue, "n": len(d),
        "effect": {"name": "r" if a.get("method", "pearson") == "pearson" else "rho", "value": main.statistic},
        "alternative": {"test": "Spearman rank correlation" if a.get("method", "pearson") == "pearson" else "Pearson correlation",
                        "statistic": (sr if a.get("method", "pearson") == "pearson" else pr).statistic,
                        "p": (sr if a.get("method", "pearson") == "pearson" else pr).pvalue},
        "fit": {"slope": lr.slope, "intercept": lr.intercept},
        "points": np.column_stack([x[idx], y[idx]]),
    }

@fn
def normality(a):
    df = load(a)
    x = df[a["value"]].dropna().astype(float).values
    if len(x) < 3:
        raise ValueError("Need at least 3 values.")
    sample = x if len(x) <= 5000 else np.random.default_rng(0).choice(x, 5000, replace=False)
    sw = st.shapiro(sample)
    (osm, osr), (slope, intercept, r) = st.probplot(sample, dist="norm")
    step = max(1, len(osm) // 400)
    return {
        "test": "Shapiro-Wilk normality test", "statistic": sw.statistic, "p": sw.pvalue, "n": len(x),
        "skew": st.skew(x), "kurtosis": st.kurtosis(x),
        "qq": {"theoretical": osm[::step], "observed": osr[::step], "slope": slope, "intercept": intercept},
        "sampled": len(x) > 5000,
    }

def _cramers_v(x, y):
    t = pd.crosstab(x, y)
    if min(t.shape) < 2:
        return None
    chi2 = st.chi2_contingency(t, correction=False)[0]
    return math.sqrt(chi2 / (t.values.sum() * (min(t.shape) - 1)))

@fn
def corr_matrix(a):
    df = load(a)
    cols = a["columns"]
    if a["method"] == "cramers_v":
        d = df[cols].astype(str)
        m = [[1.0 if i == j else _cramers_v(d[c1], d[c2]) for j, c2 in enumerate(cols)] for i, c1 in enumerate(cols)]
    else:
        m = df[cols].astype(float).corr(method=a["method"]).values
    return {"columns": cols, "matrix": m}
`;

const PY_TS = String.raw`
from statsmodels.tsa.seasonal import seasonal_decompose
from statsmodels.tsa.exponential_smoothing.ets import ETSModel

SEASON = {"D": 7, "W": 52, "MS": 12, "QS": 4}

@fn
def timeseries(a):
    df = load(a)
    s = df[[a["date"], a["value"]]].dropna().set_index(a["date"])[a["value"]].astype(float)
    freq = a["freq"]
    s = (s.resample(freq).sum() if a["agg"] == "sum" else s.resample(freq).mean()).astype(float)
    s = s.interpolate(limit_direction="both")
    if len(s) < 8:
        raise ValueError("Need at least 8 periods after resampling. Try a finer frequency.")
    m = SEASON[freq]
    seasonal = len(s) >= 2 * m + 2
    out = {"index": [d.strftime("%Y-%m-%d") for d in s.index], "values": s.values,
           "rolling": s.rolling(a.get("window", 3), min_periods=1).mean().values, "season_length": m if seasonal else None}
    if seasonal:
        dec = seasonal_decompose(s, model="additive", period=m)
        out["decomposition"] = {"trend": dec.trend.values, "seasonal": dec.seasonal.values, "resid": dec.resid.values}
        out["seasonal_strength"] = float(max(0.0, 1 - np.nanvar(dec.resid) / np.nanvar(dec.resid + dec.seasonal)))

    def fit(series):
        model = ETSModel(series, error="add", trend="add", seasonal="add" if seasonal else None,
                         seasonal_periods=m if seasonal else None, damped_trend=True)
        return model.fit(disp=False)

    # Accuracy on a holdout of the last season (or 20%), then refit on everything.
    h = min(m if seasonal else max(2, len(s) // 5), len(s) // 4) or 1
    try:
        back = fit(s.iloc[:-h]).forecast(h)
        actual = s.iloc[-h:].values
        nz = actual != 0
        out["mape"] = float(np.mean(np.abs((actual[nz] - back.values[nz]) / actual[nz]))) if nz.any() else None
    except Exception:
        out["mape"] = None
    res = fit(s)
    steps = int(a.get("horizon", m if seasonal else 6))
    pred = res.get_prediction(start=len(s), end=len(s) + steps - 1).summary_frame(alpha=0.05)
    future = pd.date_range(s.index[-1], periods=steps + 1, freq=freq)[1:]
    out["forecast"] = {"index": [d.strftime("%Y-%m-%d") for d in future], "mean": pred["mean"].values,
                       "lower": pred["pi_lower"].values, "upper": pred["pi_upper"].values}
    out["model"] = "Holt-Winters (ETS, additive" + (", seasonal" if seasonal else "") + ", damped trend)"
    return out
`;

/** Module sections, run once each inside Pyodide the first time a call needs them. */
export const PY_SECTIONS = { core: PY_CORE, stats: PY_STATS, ml: PY_ML, ts: PY_TS } as const;
export type PySection = keyof typeof PY_SECTIONS;
