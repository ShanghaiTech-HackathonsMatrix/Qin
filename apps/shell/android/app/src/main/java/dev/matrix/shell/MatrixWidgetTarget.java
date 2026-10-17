package dev.matrix.shell;

/** 点击只接受两类 HTTPS 入口；不信任传入 Intent 中的 URL。 */
final class MatrixWidgetTarget {
    static boolean allowed(String target){
        try{
            java.net.URI u=new java.net.URI(target);
            if(!"https".equals(u.getScheme())||u.getUserInfo()!=null||u.getFragment()!=null)return false;
            if("www.gradescope.com".equals(u.getHost())&&u.getPort()==-1)
                return u.getPath().matches("/courses/[0-9]+/assignments/[0-9]+/?")&&u.getQuery()==null;
            if("elearning.shanghaitech.edu.cn".equals(u.getHost())&&u.getPort()==8443)
                return "/webapps/blackboard/execute/launcher".equals(u.getPath())&&u.getQuery()!=null&&u.getQuery().matches("type=Course&id=_?[0-9]+_[0-9]+");
        }catch(Exception ignored){}
        return false;
    }
}
