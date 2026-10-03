import {placeNames} from './data/place-names-zh.js';

// Presentation overlay also covers existing workspaces, without rewriting place
// revisions, coordinates, historical references or user-created place names.
export function localizePlace(place){
 const label=placeNames[place?.id];if(!label||!place.data)return place;
 const [name,country,original]=label,d=place.data;
 return{...place,data:{...d,name,country:country||d.country,aliases:[...new Set([...(d.aliases||[]),original,...(/[a-z]/i.test(d.name)?[d.name]:[])].filter(Boolean))]}};
}
export function placeLabel(placeId,fallback){return placeNames[placeId]?.[0]||fallback;}
