"use client";

import type { Dataset } from "@/lib/data/types";
import { callPython, frameFile, type Package } from "@/lib/python/client";
import type { PySection } from "@/lib/python/module";
import { py, pyList } from "@/lib/pipeline/literals";

const PACKAGES: Package[] = ["scipy", "scikit-learn"];
const SECTIONS: PySection[] = ["ml"];
type Progress = (m: string) => void;

export interface AutoMLResult {
  task: "classification" | "regression";
  target: string;
  rows: number;
  folds: number;
  primary: string;
  best: string;
  leaderboard: ({ model: string; seconds: number } & Record<string, number>)[];
  baseline: { name: string; accuracy?: number; rmse?: number };
  importance: { feature: string; value: number }[];
  inputs: (
    | { name: string; type: "number"; min: number; max: number; default: number; integer: boolean }
    | { name: string; type: "category"; options: string[]; default: string }
  )[];
  numeric: string[];
  categorical: string[];
  confusion?: { labels: string[]; matrix: number[][] };
  roc?: { fpr: number[]; tpr: number[]; auc: number; positive: string };
  residuals?: { actual: number[]; predicted: number[] };
  modelId: string;
  features: string[];
}

export const METRIC_LABELS: Record<string, string> = {
  roc_auc: "ROC AUC",
  f1: "F1 (macro)",
  accuracy: "Accuracy",
  r2: "R²",
  rmse: "RMSE",
  mae: "MAE",
};

async function data(ds: Dataset, columns: string[], key: string, maxRows: number, withRowId = false) {
  const path = `/data/${ds.table}_v${ds.version}_${key}.csv`;
  const { file, dates } = await frameFile(ds, columns, path, maxRows, withRowId);
  return { path, dates, file };
}

const call = <T,>(fn: string, args: Record<string, unknown>, files: { path: string; data: Uint8Array }[], onProgress?: Progress) =>
  callPython<T>(fn, args, { packages: PACKAGES, sections: SECTIONS, files, onProgress });

export async function trainAutoML(
  ds: Dataset,
  target: string,
  features: string[],
  task: "auto" | "classification" | "regression",
  onProgress: Progress,
): Promise<AutoMLResult> {
  onProgress("Preparing data…");
  const { path, dates, file } = await data(ds, [target, ...features], "automl", 20_000);
  const modelId = `${ds.table}_${Date.now()}`;
  const res = await call<Omit<AutoMLResult, "modelId" | "features">>(
    "automl",
    { path, dates, fresh: true, target, features, task, model_id: modelId },
    [file],
    (m) => onProgress(m === "Running…" ? "Training 5 models with cross-validation…" : m),
  );
  return { ...res, modelId, features };
}

export function predictRows(modelId: string, rows: Record<string, unknown>[]) {
  return call<{ prediction: (string | number)[]; probabilities?: Record<string, number>[] }>("predict", { model_id: modelId, rows }, []);
}

export async function predictDataset(modelId: string, ds: Dataset, onProgress: Progress) {
  const { path, dates, file } = await data(ds, [], "predict", 1_000_000);
  return call<{ csv: string; rows: number }>("predict_file", { model_id: modelId, path, dates, fresh: true }, [file], onProgress);
}

export interface ClusterResult {
  method: "kmeans" | "dbscan";
  k: number;
  noise?: number;
  silhouette?: number | null;
  elbow?: { k: number; inertia: number; silhouette: number }[];
  points: { x: number; y: number; c: number }[];
  profiles: {
    cluster: number;
    size: number;
    traits: { feature: string; z: number; mean: number }[];
    categories: { feature: string; value: string; share: number; overall: number }[];
  }[];
  labels: number[];
  rowids: number[] | null;
}

export async function runClusters(
  ds: Dataset,
  features: string[],
  opts: { method: "kmeans" | "dbscan"; k?: number; eps?: number; min_samples?: number },
  onProgress: Progress,
) {
  const { path, dates, file } = await data(ds, features, "cluster", 50_000, true);
  return call<ClusterResult>("clusters", { path, dates, fresh: true, features, ...opts }, [file], onProgress);
}

export interface EmbedResult {
  explained?: number[];
  points: { x: number; y: number; g: string | null }[];
  sampled: boolean;
}

export async function runEmbedding(ds: Dataset, features: string[], method: "pca" | "tsne", color: string | undefined, onProgress: Progress) {
  const cols = [...features, ...(color && !features.includes(color) ? [color] : [])];
  const { path, dates, file } = await data(ds, cols, `embed_${method}`, 50_000);
  return call<EmbedResult>("embed", { path, dates, fresh: true, features, method, color }, [file], onProgress);
}

export interface AnomalyResult {
  flagged: number;
  rows: number;
  top: { row: number; score: number; why: string }[];
  points: { x: number; y: number; a: boolean }[];
}

export async function runAnomalies(ds: Dataset, features: string[], contamination: number, onProgress: Progress) {
  const { path, dates, file } = await data(ds, features, "anomaly", 100_000, true);
  return call<AnomalyResult>("anomalies", { path, dates, fresh: true, features, contamination }, [file], onProgress);
}

/** A standalone scikit-learn script that rebuilds the winning pipeline. */
export function pipelineCode(ds: Dataset, r: AutoMLResult): string {
  const kind = r.task === "classification" ? "Classifier" : "Regressor";
  const models: Record<string, [string, string]> = {
    "Logistic Regression": ["from sklearn.linear_model import LogisticRegression", "LogisticRegression(max_iter=1000)"],
    "Linear Regression": ["from sklearn.linear_model import LinearRegression", "LinearRegression()"],
    "Decision Tree": [`from sklearn.tree import DecisionTree${kind}`, `DecisionTree${kind}(max_depth=8, random_state=0)`],
    "Random Forest": [`from sklearn.ensemble import RandomForest${kind}`, `RandomForest${kind}(n_estimators=80, max_depth=12, random_state=0)`],
    "Gradient Boosting": [`from sklearn.ensemble import HistGradientBoosting${kind}`, `HistGradientBoosting${kind}(random_state=0)`],
    "K-Nearest Neighbours": [`from sklearn.neighbors import KNeighbors${kind}`, `KNeighbors${kind}(n_neighbors=15)`],
  };
  const [imp, ctor] = models[r.best];
  const scoring = r.task === "classification" ? (r.primary === "roc_auc" ? "roc_auc" : "f1_macro") : "r2";
  const cv = r.task === "classification" ? "StratifiedKFold" : "KFold";
  return `# ${r.best} for "${r.target}", exported from Datamorph
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.model_selection import cross_val_score, ${cv}
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
${imp}

df = pd.read_csv(${py(`${ds.table}_clean.csv`)})  # export the cleaned data from Datamorph
df = df[df[${py(r.target)}].notna()]

numeric = ${pyList(r.numeric)}
categorical = ${pyList(r.categorical)}
X = df[numeric + categorical]
y = df[${py(r.target)}]${r.task === "classification" ? ".astype(str)" : ""}

preprocess = ColumnTransformer([
    ("num", Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())]), numeric),
    ("cat", Pipeline([("impute", SimpleImputer(strategy="most_frequent")),
                      ("onehot", OneHotEncoder(handle_unknown="ignore", max_categories=20))]), categorical),
])
model = Pipeline([("prep", preprocess), ("model", ${ctor})])

cv = ${cv}(${r.folds}, shuffle=True, random_state=0)
scores = cross_val_score(model, X, y, cv=cv, scoring=${py(scoring)})
print(f"${METRIC_LABELS[r.primary]}: {scores.mean():.3f} ± {scores.std():.3f}")

model.fit(X, y)
# model.predict(new_df[numeric + categorical])
`;
}
