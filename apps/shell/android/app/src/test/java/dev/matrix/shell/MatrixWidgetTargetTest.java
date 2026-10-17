package dev.matrix.shell;
import static org.junit.Assert.*;
import org.junit.Test;
public class MatrixWidgetTargetTest {
    @Test public void onlyAllowsCanonicalPlatformDestinations(){
        assertTrue(MatrixWidgetTarget.allowed("https://www.gradescope.com/courses/123/assignments/456"));
        assertTrue(MatrixWidgetTarget.allowed("https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/execute/launcher?type=Course&id=_123_1"));
        for(String url:new String[]{"https://evil.test/courses/1/assignments/2","http://www.gradescope.com/courses/1/assignments/2","https://www.gradescope.com/courses/1/assignments/2?redirect=evil","https://elearning.shanghaitech.edu.cn:8443/webapps/assignment/x","https://www.gradescope.com@evil.test/courses/1/assignments/2"})assertFalse(url,MatrixWidgetTarget.allowed(url));
    }
}
