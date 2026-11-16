package io.github.ethanyoq.ainovelwriter;
import android.app.*;
import android.content.*;
import android.os.*;
/** Keeps user-initiated streaming AI requests alive while the app is backgrounded. */
public final class GenerationService extends Service {
    private PowerManager.WakeLock wake;
    @Override public void onCreate(){super.onCreate();String channel="generation";NotificationManager manager=getSystemService(NotificationManager.class);manager.createNotificationChannel(new NotificationChannel(channel,"AI 生成任务",NotificationManager.IMPORTANCE_LOW));Intent open=new Intent(this,MainActivity.class);open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);PendingIntent pending=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);Notification notification=new Notification.Builder(this,channel).setSmallIcon(android.R.drawable.ic_menu_edit).setContentTitle(getString(R.string.app_name) + " 正在连接 AI").setContentText("生成任务进行中，点击返回写作工作区").setContentIntent(pending).setOngoing(true).build();startForeground(110,notification);wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"AINovelWriter:Generation");wake.acquire(60*60*1000L);}
    @Override public int onStartCommand(Intent intent,int flags,int startId){return START_NOT_STICKY;}
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onTimeout(int startId,int foregroundServiceType){stopSelf();}
    @Override public void onDestroy(){if(wake!=null&&wake.isHeld())wake.release();super.onDestroy();}
}
