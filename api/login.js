
let users={}

export default function handler(req,res){

 if(req.method==="POST"){
  let {user,pass}=req.body

  if(!users[user]) users[user]=pass

  if(users[user]===pass){
    res.json({ok:true})
  }else{
    res.json({ok:false})
  }
 }

}
