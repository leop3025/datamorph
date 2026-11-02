// Machine-learning functions for the Pyodide module (scikit-learn), loaded with the "ml" section.
export const PY_ML = String.raw`
import time
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.model_selection import StratifiedKFold, KFold, cross_validate, cross_val_predict
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression, LinearRegression
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor
from sklearn.ensemble import (RandomForestClassifier, RandomForestRegressor,
                              HistGradientBoostingClassifier, HistGradientBoostingRegressor, IsolationForest)
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
from sklearn.metrics import confusion_matrix, roc_curve, roc_auc_score
from sklearn.cluster import KMeans, DBSCAN
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from sklearn.metrics import silhouette_score

_models = {}

def _prep_features(df, features):
    """Dates become year/month/weekday numbers; returns (X, numeric cols, categorical cols)."""
    X = df[features].copy()
    for c in list(X.columns):
        if np.issubdtype(X[c].dtype, np.datetime64):
            X[c + "_year"] = X[c].dt.year
            X[c + "_month"] = X[c].dt.month
            X[c + "_weekday"] = X[c].dt.dayofweek
            X = X.drop(columns=[c])
        elif X[c].dtype == bool:
            X[c] = X[c].astype(int)
    num = [c for c in X.columns if np.issubdtype(X[c].dtype, np.number)]
    cat = [c for c in X.columns if c not in num]
    for c in cat:
        X[c] = X[c].astype("string").astype(object).where(X[c].notna(), np.nan)
    return X, num, cat

def _preprocessor(num, cat):
    return ColumnTransformer([
        ("num", Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())]), num),
        ("cat", Pipeline([("impute", SimpleImputer(strategy="most_frequent")),
                          ("onehot", OneHotEncoder(handle_unknown="ignore", max_categories=20, sparse_output=False))]), cat),
    ])

def _task(y, requested):
    if requested in ("classification", "regression"):
        return requested
    if not np.issubdtype(y.dtype, np.number) or y.dtype == bool:
        return "classification"
    vals = y.dropna().unique()
    return "classification" if len(vals) <= 10 and np.all(np.equal(np.mod(vals, 1), 0)) else "regression"

def _candidates(task):
    if task == "classification":
        return {
            "Logistic Regression": LogisticRegression(max_iter=1000),
            "Decision Tree": DecisionTreeClassifier(max_depth=8, random_state=0),
            "Random Forest": RandomForestClassifier(n_estimators=80, max_depth=12, random_state=0),
            "Gradient Boosting": HistGradientBoostingClassifier(random_state=0),
            "K-Nearest Neighbours": KNeighborsClassifier(n_neighbors=15),
        }
    return {
        "Linear Regression": LinearRegression(),
        "Decision Tree": DecisionTreeRegressor(max_depth=8, random_state=0),
        "Random Forest": RandomForestRegressor(n_estimators=80, max_depth=12, random_state=0),
        "Gradient Boosting": HistGradientBoostingRegressor(random_state=0),
        "K-Nearest Neighbours": KNeighborsRegressor(n_neighbors=15),
    }

@fn
def automl(a):
    df = load(a)
    target, features = a["target"], [f for f in a["features"] if f != a["target"]]
    df = df[df[target].notna()]
    if len(df) > a.get("max_rows", 20000):
        df = df.sample(a.get("max_rows", 20000), random_state=0)
    y_raw = df[target]
    task = _task(y_raw, a.get("task", "auto"))
    X, num, cat = _prep_features(df, features)
    if task == "classification":
        y = y_raw.astype(str).values
        classes = sorted(pd.unique(y).tolist())
        if len(classes) < 2:
            raise ValueError("The target has only one class.")
        binary = len(classes) == 2
        min_class = pd.Series(y).value_counts().min()
        folds = max(2, min(5, int(min_class)))
        cv = StratifiedKFold(folds, shuffle=True, random_state=0)
        scoring = {"accuracy": "accuracy", "f1": "f1_macro"}
        if binary:
            scoring["roc_auc"] = "roc_auc"
        primary = "roc_auc" if binary else "f1"
        baseline = {"name": "always predicting the most common class", "accuracy": float(pd.Series(y).value_counts(normalize=True).iloc[0])}
    else:
        y = y_raw.astype(float).values
        folds = 5
        cv = KFold(folds, shuffle=True, random_state=0)
        scoring = {"r2": "r2", "rmse": "neg_root_mean_squared_error", "mae": "neg_mean_absolute_error"}
        primary = "r2"
        baseline = {"name": "always predicting the average", "rmse": float(np.std(y))}

    board = []
    for name, model in _candidates(task).items():
        pipe = Pipeline([("prep", _preprocessor(num, cat)), ("model", model)])
        t0 = time.time()
        res = cross_validate(pipe, X, y, cv=cv, scoring=scoring, error_score="raise")
        row = {"model": name, "seconds": time.time() - t0}
        for k in scoring:
            v = res["test_" + k]
            if k in ("rmse", "mae"):
                v = -v
            row[k] = float(np.mean(v))
            row[k + "_std"] = float(np.std(v))
        board.append(row)
    board.sort(key=lambda r: -r[primary])
    best_name = board[0]["model"]

    # Out-of-fold predictions of the best model give honest evaluation plots.
    best = Pipeline([("prep", _preprocessor(num, cat)), ("model", _candidates(task)[best_name])])
    details = {}
    if task == "classification":
        oof = cross_val_predict(best, X, y, cv=cv)
        details["confusion"] = {"labels": classes, "matrix": confusion_matrix(y, oof, labels=classes)}
        if binary:
            proba = cross_val_predict(best, X, y, cv=cv, method="predict_proba")[:, 1]
            fpr, tpr, _ = roc_curve(y, proba, pos_label=classes[1])
            step = max(1, len(fpr) // 200)
            details["roc"] = {"fpr": fpr[::step], "tpr": tpr[::step], "auc": roc_auc_score(y == classes[1], proba), "positive": classes[1]}
    else:
        oof = cross_val_predict(best, X, y, cv=cv)
        idx = np.random.default_rng(0).choice(len(y), size=min(len(y), 1500), replace=False)
        details["residuals"] = {"actual": y[idx], "predicted": oof[idx]}

    best.fit(X, y)
    # Permutation importance on raw input columns (before encoding), so it's readable.
    Xs, ys = (X, y) if len(X) <= 2000 else (X.sample(2000, random_state=0), pd.Series(y, index=X.index).loc[X.sample(2000, random_state=0).index].values)
    pi = permutation_importance(best, Xs, ys, n_repeats=4, random_state=0, scoring=scoring[primary])
    imp = sorted(zip(X.columns.tolist(), pi.importances_mean), key=lambda t: -t[1])

    # What-if: sensible ranges and defaults for each input.
    inputs = []
    for c in X.columns:
        if c in num:
            s = X[c].dropna()
            inputs.append({"name": c, "type": "number", "min": float(s.quantile(0.01)) if len(s) else 0, "max": float(s.quantile(0.99)) if len(s) else 1,
                           "default": float(s.median()) if len(s) else 0, "integer": bool(len(s) and np.all(np.mod(s, 1) == 0))})
        else:
            vc = X[c].value_counts()
            inputs.append({"name": c, "type": "category", "options": vc.index[:30].tolist(), "default": vc.index[0] if len(vc) else ""})

    model_id = a["model_id"]
    _models[model_id] = {"pipe": best, "task": task, "features": features, "columns": X.columns.tolist(), "classes": classes if task == "classification" else None}
    return {"task": task, "target": target, "rows": len(X), "folds": folds, "primary": primary, "leaderboard": board, "best": best_name,
            "baseline": baseline, "importance": [{"feature": f, "value": v} for f, v in imp], "inputs": inputs,
            "numeric": num, "categorical": cat, **details}

def _frame_for(m, df):
    X, _, _ = _prep_features(df, m["features"])
    for c in m["columns"]:
        if c not in X.columns:
            X[c] = np.nan
    return X[m["columns"]]

@fn
def predict(a):
    m = _models[a["model_id"]]
    df = pd.DataFrame(a["rows"])
    for c in m["features"]:
        if c not in df.columns:
            df[c] = np.nan
    X = _frame_for(m, df)
    out = {"prediction": m["pipe"].predict(X).tolist()}
    if m["task"] == "classification" and hasattr(m["pipe"], "predict_proba"):
        out["probabilities"] = [dict(zip(m["pipe"].classes_.tolist(), p)) for p in m["pipe"].predict_proba(X)]
    return out

@fn
def predict_file(a):
    m = _models[a["model_id"]]
    df = load(a)
    missing = [c for c in m["features"] if c not in df.columns]
    if missing:
        raise ValueError("The file is missing columns: " + ", ".join(missing))
    out = df.copy()
    out["prediction"] = m["pipe"].predict(_frame_for(m, df))
    if m["task"] == "classification":
        proba = m["pipe"].predict_proba(_frame_for(m, df))
        out["confidence"] = proba.max(axis=1).round(4)
    return {"csv": out.to_csv(index=False), "rows": len(out)}

# ---------- unsupervised ----------

def _matrix(df, features):
    X, num, cat = _prep_features(df, features)
    Z = _preprocessor(num, cat).fit_transform(X)
    return X, num, cat, Z

def _profiles(X, num, cat, labels):
    """Describe each cluster by how far its averages sit from the overall average (in std units)."""
    out = []
    mu, sd = X[num].mean(), X[num].std().replace(0, 1)
    for k in sorted(set(labels)):
        part = X[labels == k]
        z = ((part[num].mean() - mu) / sd).sort_values(key=np.abs, ascending=False)
        traits = [{"feature": f, "z": float(v), "mean": float(part[f].mean())} for f, v in z.items() if abs(v) >= 0.3][:4]
        tops = []
        for c in cat:
            vc = part[c].value_counts(normalize=True)
            base = X[c].value_counts(normalize=True)
            if len(vc):
                v = vc.index[0]
                if vc.iloc[0] - base.get(v, 0) >= 0.15:
                    tops.append({"feature": c, "value": str(v), "share": float(vc.iloc[0]), "overall": float(base.get(v, 0))})
        out.append({"cluster": int(k), "size": int(len(part)), "traits": traits, "categories": tops[:2],
                    "means": {f: float(part[f].mean()) for f in num}})
    return out

@fn
def clusters(a):
    df = load(a)
    X, num, cat, Z = _matrix(df, a["features"])
    rng = np.random.default_rng(0)
    sample = rng.choice(len(Z), size=min(len(Z), 3000), replace=False)
    result = {"method": a["method"]}
    if a["method"] == "kmeans":
        elbow = []
        for k in range(2, 11):
            km = KMeans(n_clusters=k, n_init=4, random_state=0).fit(Z)
            elbow.append({"k": k, "inertia": float(km.inertia_), "silhouette": float(silhouette_score(Z[sample], km.labels_[sample]))})
        k = a.get("k") or max(elbow, key=lambda e: e["silhouette"])["k"]
        labels = KMeans(n_clusters=k, n_init=4, random_state=0).fit_predict(Z)
        result.update({"elbow": elbow, "k": k})
    else:
        labels = DBSCAN(eps=a.get("eps", 0.8), min_samples=a.get("min_samples", 8)).fit_predict(Z)
        result["noise"] = int((labels == -1).sum())
        result["k"] = int(len(set(labels)) - (1 if -1 in labels else 0))
    coords = PCA(n_components=2, random_state=0).fit_transform(Z)
    result["points"] = [{"x": float(coords[i, 0]), "y": float(coords[i, 1]), "c": int(labels[i])} for i in sample]
    result["profiles"] = _profiles(X, num, cat, labels)
    result["labels"] = labels.tolist()
    result["rowids"] = df["__row"].tolist() if "__row" in df.columns else None
    if len(set(labels) - {-1}) > 1:
        result["silhouette"] = float(silhouette_score(Z[sample], labels[sample])) if len(set(labels[sample])) > 1 else None
    return result

@fn
def embed(a):
    df = load(a)
    X, num, cat, Z = _matrix(df, a["features"])
    color = df[a["color"]].astype(str).values if a.get("color") else None
    if a["method"] == "pca":
        k = min(10, Z.shape[1])
        pca = PCA(n_components=k, random_state=0).fit(Z)
        coords = pca.transform(Z)[:, :2]
        names = pca.feature_names_in_ if hasattr(pca, "feature_names_in_") else None
        res = {"explained": pca.explained_variance_ratio_.tolist()}
        idx = np.random.default_rng(0).choice(len(Z), size=min(len(Z), 3000), replace=False)
    else:
        idx = np.random.default_rng(0).choice(len(Z), size=min(len(Z), 1500), replace=False)
        coords_s = TSNE(n_components=2, perplexity=min(30, max(5, len(idx) // 4)), init="pca", random_state=0).fit_transform(Z[idx])
        coords = np.zeros((len(Z), 2))
        coords[idx] = coords_s
        res = {}
    res["points"] = [{"x": float(coords[i, 0]), "y": float(coords[i, 1]), "g": (None if color is None else color[i])} for i in idx]
    res["sampled"] = len(idx) < len(Z)
    return res

@fn
def anomalies(a):
    df = load(a)
    X, num, cat, Z = _matrix(df, a["features"])
    iso = IsolationForest(contamination=a.get("contamination", 0.02), random_state=0).fit(Z)
    score = -iso.score_samples(Z)
    flag = iso.predict(Z) == -1
    order = np.argsort(-score)[: int(flag.sum())]
    coords = PCA(n_components=2, random_state=0).fit_transform(Z)
    idx = np.random.default_rng(0).choice(len(Z), size=min(len(Z), 3000), replace=False)
    idx = np.unique(np.concatenate([idx, order[:300]]))
    mu, sd = X[num].mean(), X[num].std().replace(0, 1)
    why = []
    for i in order[:100]:
        z = ((X.iloc[i][num] - mu) / sd).astype(float).abs().sort_values(ascending=False)
        why.append(", ".join(f"{f} {'high' if X.iloc[i][f] > mu[f] else 'low'}" for f in z.index[:2] if z[f] >= 1.5) or "unusual combination")
    return {"flagged": int(flag.sum()), "rows": len(Z),
            "top": [{"row": int(df["__row"].iloc[i]), "score": float(score[i]), "why": why[j] if j < len(why) else ""} for j, i in enumerate(order[:100])],
            "points": [{"x": float(coords[i, 0]), "y": float(coords[i, 1]), "a": bool(flag[i])} for i in idx]}
`;
