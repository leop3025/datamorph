export interface Sample {
  file: string;
  title: string;
  description: string;
}

export const SAMPLES: Sample[] = [
  { file: "titanic.csv", title: "Titanic", description: "891 passengers · survival, class, age, fare" },
  { file: "iris.csv", title: "Iris", description: "150 flowers · 4 measurements, 3 species" },
  { file: "sales.csv", title: "Retail sales", description: "5k orders · deliberately messy (synthetic)" },
  { file: "chennai_weather.csv", title: "Chennai weather", description: "3 years daily · seasonal (synthetic)" },
];
