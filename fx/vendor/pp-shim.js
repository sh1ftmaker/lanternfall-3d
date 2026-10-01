// N8AO's bundle imports `Pass` from pmndrs "postprocessing" for its N8AOPostPass; we only use the three.js
// N8AOPass, so an empty base class satisfies the import without downloading that library.
export class Pass {}
