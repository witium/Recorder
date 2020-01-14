/*
录音 Recorder扩展，频率直方图显示
使用本扩展需要引入lib.fft.js支持，直方图特意优化主要显示0-10khz语音部分，其他高频显示区域较小，不适合用来展示音乐频谱

https://github.com/xiangyuecn/Recorder

本扩展核心算法主要参考了Java开源库jmp123 版本0.3 的代码：
https://www.iteye.com/topic/851459
https://sourceforge.net/projects/jmp123/files/
*/
(function(){
"use strict";

var FrequencyHistogramView=function(set){
	return new fn(set);
};
var fn=function(set){
	var This=this;
	var o={
		/*
		elem:"css selector" //自动显示到dom，并以此dom大小为显示大小
			//或者配置显示大小，手动把frequencyObj.elem显示到别的地方
		,width:0 //显示宽度
		,height:0 //显示高度
		
		以上配置二选一
		*/
		
		scale:2 //缩放系数，应为正整数，使用2(3? no!)倍宽高进行绘制，避免移动端绘制模糊
		
		,fps:20 //绘制帧率，不可过高
		
		,lineCount:30 //直方图柱子数量，数量的多少对性能影响不大，密集运算集中在FFT算法中
		,lineWidth:6 //柱子线条基础粗细，当视图可以容下lineCount这么多时才会生效，否则自适应
		,minHeight:0 //柱子保留基础高度，position不为±1时应该保留点高度
		,position:-1 //绘制位置，取值-1到1，-1为最底下，0为中间，1为最顶上，小数为百分比
		
		,stripeEnable:true //是否启用柱子顶上的峰值小横条，position不是-1时应当关闭，否则会很丑
		,stripeHeight:3 //峰值小横条基础高度
		,stripeMargin:6 //峰值小横条和柱子保持的基础距离
		
		,fallDuration:1000 //柱子从最顶上下降到最底部最长时间ms
		,stripeFallDuration:3500 //峰值小横条从最顶上下降到底部最长时间ms
		
		//柱子颜色配置：[位置，css颜色，...] 位置: 取值0.0-1.0之间
		,linear:[0,"rgba(0,187,17,1)",0.5,"rgba(255,215,0,1)",1,"rgba(255,102,0,1)"]
		//峰值小横条渐变颜色配置，取值格式和linear一致，留空为柱子的渐变颜色
		,stripeLinear:null
		
		,shadowBlur:0 //柱子阴影基础大小，设为0不显示阴影
		,shadowColor:"#bbb" //柱子阴影颜色
		,stripeShadowBlur:-1 //峰值小横条阴影基础大小，设为0不显示阴影，-1为柱子的大小
		,stripeShadowColor:"" //峰值小横条阴影颜色，留空为柱子的阴影颜色
		
		//当发生绘制时会回调此方法，参数为当前绘制的频率数据和采样率，可实现多个直方图同时绘制，只消耗一个input输入和计算时间
		,onDraw:function(frequencyData,sampleRate){}
	};
	for(var k in set){
		o[k]=set[k];
	};
	This.set=set=o;
	
	var elem=set.elem;
	if(elem){
		if(typeof(elem)=="string"){
			elem=document.querySelector(elem);
		}else if(elem.length){
			elem=elem[0];
		};
	};
	if(elem){
		set.width=elem.offsetWidth;
		set.height=elem.offsetHeight;
	};
	
	var scale=set.scale;
	var width=set.width*scale;
	var height=set.height*scale;
	
	var thisElem=This.elem=document.createElement("div");
	var lowerCss=["","transform-origin:0 0;","transform:scale("+(1/scale)+");"];
	thisElem.innerHTML='<div style="width:'+set.width+'px;height:'+set.height+'px;overflow:hidden"><div style="width:'+width+'px;height:'+height+'px;'+lowerCss.join("-webkit-")+lowerCss.join("-ms-")+lowerCss.join("-moz-")+lowerCss.join("")+'"><canvas/></div></div>';
	
	var canvas=This.canvas=thisElem.querySelector("canvas");
	var ctx=This.ctx=canvas.getContext("2d");
	canvas.width=width;
	canvas.height=height;
	
	if(elem){
		elem.innerHTML="";
		elem.appendChild(thisElem);
	};
	
	if(!Recorder.LibFFT){
		throw new Error("需要lib.fft.js支持");
	};
	This.fft=Recorder.LibFFT(1024);
	
	//柱子所在高度
	This.lastH=[];
	//峰值小横条所在高度
	This.stripesH=[];
};
fn.prototype=FrequencyHistogramView.prototype={
	genLinear:function(ctx,colors,from,to){
		var rtv=ctx.createLinearGradient(0,from,0,to);
		for(var i=0;i<colors.length;){
			rtv.addColorStop(colors[i++],colors[i++]);
		};
		return rtv;
	}
	,input:function(pcmData,powerLevel,sampleRate){
		var This=this;
		This.sampleRate=sampleRate;
		This.pcmData=pcmData;
		This.pcmPos=0;
		
		This.inputTime=Date.now();
		This.schedule();
	}
	,schedule:function(){
		var This=this,set=This.set;
		var interval=Math.floor(1000/set.fps);
		if(!This.timer){
			This.timer=setInterval(function(){
				This.schedule();
			},interval);
		};
		
		var now=Date.now();
		var drawTime=This.drawTime||0;
		if(now-This.inputTime>set.stripeFallDuration*1.3){
			//超时没有输入，顶部横条已全部落下，干掉定时器
			clearInterval(This.timer);
			This.timer=0;
			return;
		};
		if(now-drawTime<interval){
			//没到间隔时间，不绘制
			return;
		};
		This.drawTime=now;
		
		//调用FFT计算频率数据
		var bufferSize=This.fft.bufferSize;
		var pcm=This.pcmData;
		var pos=This.pcmPos;
		var arr=new Int16Array(bufferSize);
		for(var i=0;i<bufferSize&&pos<pcm.length;i++,pos++){
			arr[i]=pcm[pos];
		};
		This.pcmPos=pos;
		
		var frequencyData=This.fft.transform(arr);
		
		//推入绘制
		This.draw(frequencyData,This.sampleRate);
	}
	,draw:function(frequencyData,sampleRate){
		var This=this,set=This.set;
		var ctx=This.ctx;
		var scale=set.scale;
		var width=set.width*scale;
		var height=set.height*scale;
		var lineCount=set.lineCount;
		var bufferSize=This.fft.bufferSize;
		
		
		//计算高度位置
		var position=set.position;
		var posAbs=Math.abs(set.position);
		var originY=position==1?0:height;//y轴原点
		var heightY=height;//最高的一边高度
		if(posAbs<1){
			heightY=heightY/2;
			originY=heightY;
			heightY=Math.floor(heightY*(1+posAbs));
			originY=Math.floor(position>0?originY*(1-posAbs):originY*(1+posAbs));
		};
		
		var lastH=This.lastH;
		var stripesH=This.stripesH;
		var speed=Math.ceil(heightY/(set.fallDuration/(1000/set.fps)));
		var stripeSpeed=Math.ceil(heightY/(set.stripeFallDuration/(1000/set.fps)));
		var stripeMargin=set.stripeMargin*scale;
		
		var Y0=1 << (Math.round(Math.log(bufferSize)/Math.log(2) + 3) << 1);
		var logY0 = Math.log(Y0)/Math.log(10);
		var dBmax=20*Math.log(0x7fff)/Math.log(10);
		
		var fftSize=bufferSize/2;
		var fftSize10k=Math.floor(fftSize*10000/sampleRate);//10khz所在位置
		var line80=Math.round(lineCount*0.8);//80%的柱子位置
		var fftSizeStep1=fftSize10k/line80;
		var fftSizeStep2=(fftSize-fftSize10k)/(lineCount-line80);
		var fftIdx=0;
		for(var i=0;i<lineCount;i++){
			//不采用jmp123的非线性划分频段，录音语音并不适用于音乐的频率，应当弱化高频部分
			//80%关注0-10khz主要人声部分 20%关注剩下的高频，这样不管什么采样率都能做到大部分频率显示一致。
			var start=Math.ceil(fftIdx);
			if(i<line80){
				//10khz以下
				fftIdx+=fftSizeStep1;
			}else{
				//10khz以上
				fftIdx+=fftSizeStep2;
			};
			var end=Math.min(Math.ceil(fftIdx),fftSize);
			
			
			//参考AudioGUI.java .drawHistogram方法
			
			//查找当前频段的最大"幅值"
			var maxAmp=0;
			for (var j=start; j<end; j++) {
				maxAmp=Math.max(maxAmp,Math.abs(frequencyData[j]));
			};
			
			//计算音量
			var dB= (maxAmp > Y0) ? Math.floor((Math.log(maxAmp)/Math.log(10) - logY0) * 17) : 0;
			var h=heightY*Math.min(dB/dBmax,1);
			
			//使柱子匀速下降
			lastH[i]=(lastH[i]||0)-speed;
			if(h<lastH[i]){h=lastH[i];};
			if(h<0){h=0;};
			lastH[i]=h;
			
			var shi=stripesH[i]||0;
			if(h&&h+stripeMargin>shi) {
				stripesH[i]=h+stripeMargin;
			}else{
				//使峰值小横条匀速度下落
				var sh =shi-stripeSpeed;
				if(sh < 0){sh = 0;};
				stripesH[i] = sh;
			};
		};
		
		//开始绘制图形
		ctx.clearRect(0,0,width,height);
		
		var linear1=This.genLinear(ctx,set.linear,originY,originY-heightY);//上半部分的填充
		var stripeLinear1=set.stripeLinear&&This.genLinear(ctx,set.stripeLinear,originY,originY-heightY)||linear1;//上半部分的峰值小横条填充
		
		var linear2=This.genLinear(ctx,set.linear,originY,originY+heightY);//下半部分的填充
		var stripeLinear2=set.stripeLinear&&This.genLinear(ctx,set.stripeLinear,originY,originY+heightY)||linear2;//上半部分的峰值小横条填充
		
		//绘制柱子
		ctx.shadowBlur=set.shadowBlur*scale;
		ctx.shadowColor=set.shadowColor;
		var lineWidth=set.lineWidth*scale;
		if(lineWidth*lineCount+(lineCount+1)*scale>width){//放不下了，调小点
			lineWidth=Math.max(1*scale,Math.floor((width-(lineCount+1)*scale)/lineCount));
		};
		var spaceFloat=(width-lineCount*lineWidth)/(lineCount+1);//均匀间隔，首尾都留空
		var minHeight=set.minHeight*scale;
		for(var i=0,xFloat=0,x,y,h;i<lineCount;i++){
			xFloat+=spaceFloat;
			x=Math.floor(xFloat);
			h=Math.max(lastH[i],minHeight);
			
			//绘制上半部分
			if(originY!=0){
				y=originY-h;
				ctx.fillStyle=linear1;
				ctx.fillRect(x, y, lineWidth, h);
			};
			//绘制下半部分
			if(originY!=height){
				ctx.fillStyle=linear2;
				ctx.fillRect(x, originY, lineWidth, h);
			};
			
			xFloat+=lineWidth;
		};
		
		//绘制柱子顶上峰值小横条
		if(set.stripeEnable){
			var stripeShadowBlur=set.stripeShadowBlur;
			ctx.shadowBlur=(stripeShadowBlur==-1?set.shadowBlur:stripeShadowBlur)*scale;
			ctx.shadowColor=set.stripeShadowColor||set.shadowColor;
			var stripeHeight=set.stripeHeight*scale;
			for(var i=0,xFloat=0,x,y,h;i<lineCount;i++){
				xFloat+=spaceFloat;
				x=Math.floor(xFloat);
				h=stripesH[i];
				
				//绘制上半部分
				if(originY!=0){
					y=originY-h-stripeHeight;
					if(y<0){y=0;};
					ctx.fillStyle=stripeLinear1;
					ctx.fillRect(x, y, lineWidth, stripeHeight);
				};
				//绘制下半部分
				if(originY!=height){
					y=originY+h;
					if(y+stripeHeight>height){
						y=height-stripeHeight;
					};
					ctx.fillStyle=stripeLinear2;
					ctx.fillRect(x, y, lineWidth, stripeHeight);
				};
				
				xFloat+=lineWidth;
			};
		};
		
		set.onDraw(frequencyData);
	}
};
Recorder.FrequencyHistogramView=FrequencyHistogramView;

	
})();