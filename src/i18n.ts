import {useSyncExternalStore} from 'react';
import messages from './messages.json';
export type Language='tr'|'en'|'de'|'fr';
export const languages:Record<Language,string>={tr:'Türkçe',en:'English',de:'Deutsch',fr:'Français'};
export function detectLanguage(values:readonly string[]):Language{for(const value of values){const key=value.toLowerCase().split(/[-_]/)[0];if(key in languages)return key as Language;}return 'en';}
function read(key:string){try{return localStorage.getItem(key);}catch{return null;}}
const saved=read('ssp.language');let language:Language=saved&&saved in languages?saved as Language:detectLanguage(typeof navigator==='undefined'?['en']:navigator.languages?.length?navigator.languages:[navigator.language]);
let stable=read('ssp.stability')==='true'||(read('ssp.stability')===null&&typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches);
const listeners=new Set<()=>void>();const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);}};
function persist(key:string,value:string){try{localStorage.setItem(key,value);}catch{}}
export function setLanguage(value:Language){language=value;persist('ssp.language',value);if(typeof document!=='undefined')document.documentElement.lang=value;listeners.forEach(listener=>listener());}
export function setStability(value:boolean){stable=value;persist('ssp.stability',String(value));listeners.forEach(listener=>listener());}
export function usePreferences(){useSyncExternalStore(subscribe,()=>`${language}:${stable}`);return {language,stable,setLanguage,setStability};}
export const locale=()=>({tr:'tr-TR',en:'en-US',de:'de-DE',fr:'fr-FR'}[language]);
export function t(key:string,values:Record<string,string|number|undefined>={}){const dictionary=(messages as Record<string,Record<string,string>>)[language]??{};let value=dictionary[key]??key;for(const [name,content]of Object.entries(values))value=value.replaceAll(`{${name}}`,String(content??''));return value;}
if(typeof document!=='undefined')document.documentElement.lang=language;
