/** Render quality presets (not gameplay). Index matches Settings.quality. */
export interface QualityPreset {
  name: 'low' | 'medium' | 'high' | 'ultra';
  shadows: boolean;
  shadowMap: number;
  shadowExtent: number;
  fxaa: boolean;
  maxDynScale: number;
  pixelRatioCap: number;
  viewFar: number;
  trafficCars: number;
  pedestrians: number;
  /** Rain streaks around the camera in the rooftop moment. */
  rainStreaks: number;
}

export const QUALITY: QualityPreset[] = [
  { name: 'low', shadows: false, shadowMap: 1024, shadowExtent: 60, fxaa: false, maxDynScale: 1, pixelRatioCap: 1, viewFar: 1700, trafficCars: 90, pedestrians: 120, rainStreaks: 1600 },
  { name: 'medium', shadows: true, shadowMap: 2048, shadowExtent: 75, fxaa: true, maxDynScale: 1, pixelRatioCap: 1.5, viewFar: 2300, trafficCars: 180, pedestrians: 240, rainStreaks: 2800 },
  { name: 'high', shadows: true, shadowMap: 2048, shadowExtent: 110, fxaa: true, maxDynScale: 1, pixelRatioCap: 1.5, viewFar: 2900, trafficCars: 280, pedestrians: 380, rainStreaks: 3800 },
  { name: 'ultra', shadows: true, shadowMap: 4096, shadowExtent: 150, fxaa: true, maxDynScale: 1, pixelRatioCap: 2, viewFar: 3200, trafficCars: 400, pedestrians: 560, rainStreaks: 4800 },
];
