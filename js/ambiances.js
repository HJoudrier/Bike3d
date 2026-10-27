/* Bike3D — ambiances (palettes de couleurs et lumière) tirées au hasard pour chaque paysage. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};

  const list = [
    {
      id: 'printemps', name: 'Printemps fleuri',
      sky: { top: '#4aa8f0', horizon: '#d4f0ff', fog: '#cfe9fb' },
      sun: { color: '#fff4dc', intensity: 3.3, elev: 52, azim: 135 },
      hemi: { sky: '#cfe8ff', ground: '#86b860', intensity: 1.7 },
      grass: ['#86d45a', '#9fe06c', '#74c64e'], meadow: '#a6e273', forestFloor: '#4f9a40',
      alpine: '#b9d572', rock: '#a3a3a8', rockDark: '#7b7c86', snow: '#f6fbff', sand: '#ecd9a0', dirt: '#cdb98e',
      conifer: ['#2f8150', '#357f4a', '#2c7457'], decid: ['#62bd48', '#78c94e', '#53ad45', '#8fd05a'],
      bush: ['#4fa443', '#62b34b'], poplar: ['#5aac43', '#6cbc4c'], grassTuft: ['#7fd25a', '#94de67'],
      flowers: ['#ffffff', '#ffd84a', '#ff7aa8', '#b88cff', '#ff5a5a'],
      crops: [['#93d65a', 3], ['#c3e86a', 2], ['#e9cf55', 2], ['#a5794b', 1], ['#b99be6', 0.4], ['#f5e16b', 1]],
      water: { deep: '#2f8fd1', shallow: '#5fd0e8' }, rockTint: ['#b1b1b6', '#9a9aa2', '#bdb8b2']
    },
    {
      id: 'ete', name: 'Plein été',
      sky: { top: '#2f95e8', horizon: '#c7ebff', fog: '#c4e4f6' },
      sun: { color: '#fff1cf', intensity: 3.6, elev: 62, azim: 160 },
      hemi: { sky: '#c2e2ff', ground: '#9aa85a', intensity: 1.6 },
      grass: ['#8cc94e', '#a3d25a', '#7bbb47'], meadow: '#b4d866', forestFloor: '#4c8c38',
      alpine: '#c4cf6e', rock: '#a8a6a6', rockDark: '#7f7d82', snow: '#f8fbff', sand: '#f0dca0', dirt: '#d4bf8f',
      conifer: ['#2a7646', '#30744a', '#28684d'], decid: ['#4fa83e', '#62b445', '#479b3a', '#73bf4c'],
      bush: ['#4b9a3c', '#5aa844'], poplar: ['#4f9f3d', '#5fae45'], grassTuft: ['#8ccb52', '#a2d65e'],
      flowers: ['#ffffff', '#ffd23a', '#ff6b4a', '#9b7bff'],
      crops: [['#efcd4b', 3], ['#e3b93f', 2], ['#9fd35a', 2], ['#a87a48', 1], ['#a68ae0', 0.5], ['#f7d334', 1]],
      water: { deep: '#2582c9', shallow: '#4cc6e3' }, rockTint: ['#b4b1ae', '#9e9b9a', '#c4bdb3']
    },
    {
      id: 'automne', name: 'Automne doré',
      sky: { top: '#5aa2dc', horizon: '#f2e6cf', fog: '#eadfcc' },
      sun: { color: '#ffe2b0', intensity: 3.2, elev: 38, azim: 210 },
      hemi: { sky: '#e6dccb', ground: '#a8884f', intensity: 1.6 },
      grass: ['#9cbf55', '#b0c75c', '#8db04d'], meadow: '#bfc766', forestFloor: '#8a6a37',
      alpine: '#c9b56a', rock: '#a59a90', rockDark: '#7f746c', snow: '#fbfbff', sand: '#e9d29a', dirt: '#c9ad80',
      conifer: ['#2f6d47', '#356a45', '#2b6250'], decid: ['#e8862e', '#d9532f', '#f2b33a', '#c9a43a', '#b6c049'],
      bush: ['#c97a34', '#a9a142'], poplar: ['#f0c03c', '#e5a632'], grassTuft: ['#a9c35c', '#c2c768'],
      flowers: ['#ffffff', '#ffc23a', '#d9534f'],
      crops: [['#a5784a', 3], ['#c9a45a', 2], ['#e7c55a', 2], ['#9cbf55', 1], ['#d98c3a', 1]],
      water: { deep: '#2a7fb8', shallow: '#58bcd6' }, rockTint: ['#b3a79c', '#9d9086', '#c4b6a6']
    },
    {
      id: 'soir', name: 'Fin de journée',
      sky: { top: '#5b7fd6', horizon: '#ffd2a1', fog: '#f4cfae' },
      sun: { color: '#ffc68a', intensity: 3.4, elev: 30, azim: 250 },
      hemi: { sky: '#ffd9c0', ground: '#7d8f55', intensity: 1.45 },
      grass: ['#93c656', '#a7cf5f', '#83b84e'], meadow: '#b6d36a', forestFloor: '#4b8540',
      alpine: '#c6c873', rock: '#ab9d95', rockDark: '#86766f', snow: '#fff3ea', sand: '#f1d6a2', dirt: '#d1b48c',
      conifer: ['#2d7149', '#346e46', '#2a654f'], decid: ['#58ac43', '#6dba4b', '#4ea040', '#89c656'],
      bush: ['#4f9c42', '#5fa94a'], poplar: ['#55a443', '#68b24b'], grassTuft: ['#90c958', '#a5d363'],
      flowers: ['#ffffff', '#ffd04a', '#ff7f9f', '#c28cff'],
      crops: [['#eac35a', 3], ['#9fcf5a', 2], ['#b08250', 1], ['#b796e6', 0.4], ['#f3d24a', 1]],
      water: { deep: '#3b78c4', shallow: '#7cc4e0' }, rockTint: ['#b9a79d', '#a18f86', '#cbb5a7']
    }
  ];

  B3D.ambiances = list;
})(typeof window !== 'undefined' ? window : globalThis);
