import {useState,type FormEvent} from 'react';
import {Modal} from './App';
import ConnectionFields,{emptyConnection,connectionBody} from './ConnectionFields';
import {ArrowRight,LoaderCircle} from './icons';
import {t} from './i18n';
export default function ServerWizard({api,initialHost,onClose,onCreated,notify}:{api:<T>(path:string,method?:string,body?:unknown)=>Promise<T>;initialHost:string;onClose:()=>void;onCreated:(id:string)=>void;notify:(message:string,error?:boolean)=>void}){
 const [connection,setConnection]=useState({...emptyConnection,host:initialHost}),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{const response=await api<any>('/api/servers','POST',{installed:true,name,connection:connectionBody(connection),directory:connection.directory});notify(t('Uzak sunucu bağlandı.'));onCreated(response.id);}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
 return <Modal title={t('Sunucu bağla')} subtitle={t('Mevcut uzak sunucunun bağlantı bilgilerini gir.')} onClose={onClose} wide><form className="form-stack" onSubmit={submit}><label>{t('Bağlantı adı')}<input value={name} maxLength={80} onChange={event=>setName(event.target.value)}/></label><ConnectionFields value={connection} onChange={setConnection} api={api} prefix="/api/connections" disabled={busy}/>{error&&<div className="notice error" role="alert">{t(error)}</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>{t('Vazgeç')}</button><button className="button primary" disabled={busy}>{busy?<LoaderCircle className="spin" size={18}/>:<ArrowRight size={18}/>} {t('Sunucuya bağlan')}</button></div></form></Modal>;
}
