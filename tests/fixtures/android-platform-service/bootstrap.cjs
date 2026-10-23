const net=require('node:net');
const {receive,send}=require('../../../src/modules/android/process-channel');
const socket=new net.Socket({fd:5});
receive(socket,value=>process.send(value),error=>{console.error(error);process.exit(1);});
process.on('message',value=>send(socket,value).catch(error=>{console.error(error);process.exit(1);}));
socket.on('end',()=>process.exit(0));
